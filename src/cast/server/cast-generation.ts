/**
 * Cast generation shared by the editor's server fns and the MCP tools
 * (#1979): regenerate a character or location sheet, recast a character
 * with library talent or a location with a library location, design a
 * character's voice and cancel that design. Each spends credits through the
 * workflow it triggers.
 */
import { safeTextToImageModel } from '@/models/models';
import { resolveSequenceStyleConfig } from '@/look/style-config';
import { buildCastingAttributes } from '@/cast/character-prompt';
import { personLocksOf } from '@/cast/server/person-lock';
import { shouldReuseTalentSheet } from '@/cast/server/talent/reuse-talent-sheet';
import { castChannelId } from '@/cast/cast-channel';
import { getGenerationChannel } from '@/platform/realtime';
import { requireCharacter } from '@/cast/server/cast-edit';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type {
  CharacterSheetWorkflowInput,
  LocationSheetWorkflowInput,
  RecastCharacterWorkflowInput,
  RecastLocationWorkflowInput,
} from '@/platform/server/workflow/types';
import { buildRecastRegenerateSnapshots } from '@/cast/server/workflows/recast-snapshot';
import { characterToBible } from '@/cast/server/bibles-from-scoped';
import { enqueueCharacterVoiceDesign } from '@/cast/server/voice/enqueue-character-voice';
import { releaseReplacedVoice } from '@/cast/server/voice/release-voice';
import { isElevenLabsConfigured } from '@/models/server/elevenlabs-config';
import { lookSheetFaceRefusal } from '@/cast/look-sheet-face';
import { buildRegenerateCharacterSheetPayload } from '@/cast/server/sheets/character-sheet-trigger';
import {
  requireCharacterLook,
  requireLiveLook,
} from '@/cast/server/character-look';
import {
  buildRegenerateLocationSheetPayload,
  toLocationMetadata,
} from '@/cast/server/sheets/location-sheet-trigger';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';

const logger = getLogger(['openstory', 'cast', 'cast-generation']);

type Actor = { userId: string };

async function emitProgress(
  channelId: string,
  emit: (channel: ReturnType<typeof getGenerationChannel>) => Promise<unknown>
): Promise<void> {
  try {
    await emit(getGenerationChannel(channelId));
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }
}

/**
 * Recast accepts talents owned by the requesting team OR public talents.
 * Mirrors the read-side ACL in `talent.getWithRelations`. This is a
 * permission boundary: a regression would let one team recast with another
 * team's private talent.
 */
export function assertTalentAccessible(
  talent: { teamId: string; isPublic: boolean | null },
  contextTeamId: string
): void {
  if (talent.teamId !== contextTeamId && !talent.isPublic) {
    throw new ValidationError('Talent does not belong to your team');
  }
}

/**
 * Regenerate the character sheet from the current bible. Does not recast
 * talent, does not regenerate shots — stills go stale by derivation once
 * the new version is selected.
 */
export async function regenerateCharacterSheet(
  scopedDb: ScopedDb,
  actor: Actor,
  /** Null from the Characters page (#2017): no sequence model, no event. */
  sequence: Sequence | null,
  data: {
    characterId: string;
    /** The look to draw (#2015). A character id names its default look. */
    lookId: string;
    imageModel?: string;
  }
): Promise<{ characterId: string; workflowRunId: string }> {
  const character = await requireCharacter(
    scopedDb,
    sequence?.id ?? null,
    data.characterId
  );

  // A removed look is not drawn: nobody could pick the sheet.
  const look = requireLiveLook(
    await requireCharacterLook(scopedDb, character, data.lookId)
  );
  // A look other than the default is drawn from the default look's sheet.
  const refusal = lookSheetFaceRefusal(character.looks, look.isDefault);
  if (refusal) throw new ValidationError(refusal);
  const payload = await buildRegenerateCharacterSheetPayload({
    scopedDb,
    userId: actor.userId,
    teamId: scopedDb.teamId,
    sequence,
    character,
    lookId: data.lookId,
    imageModel: data.imageModel,
  });

  // The claim (#1113): last kickoff wins, and any edit to the look's sheet
  // inputs before this run lands revokes it.
  const { versionId: sheetVersionId } =
    await scopedDb.characterLooks.claimSheet(payload.lookId, payload, {
      markGenerating: true,
    });
  await emitProgress(
    castChannelId(payload.sequenceId, character.id),
    (channel) =>
      channel.emit('generation.character-sheet:progress', {
        characterId: character.id,
        lookId: payload.lookId,
        status: 'generating',
      })
  );

  let workflowRunId: string;
  try {
    const claimed: CharacterSheetWorkflowInput = {
      ...payload,
      sheetVersionId,
    };
    workflowRunId = await triggerWorkflow('/character-sheet', claimed, {
      // Explicit regen must not reuse the bible-child id
      // `character-sheet:${id}` — that instance is already complete, and CF
      // would no-op a second Generate (sheetStatus stuck at generating).
      // Same pattern as generateTalentSheetFn: omit dedup so each click is a
      // new run.
    });
  } catch (error) {
    await scopedDb.characterLooks.failSheetClaim(
      payload.lookId,
      sheetVersionId,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
  return { characterId: character.id, workflowRunId };
}

/**
 * Recast a character with different talent, triggering sheet regeneration.
 * The recast is ONE new bible version (and a voice version where the voice
 * changes). Every sequence that casts the character reads it; only the
 * launching sequence's default-look shots are regenerated by the recast run,
 * the others read stale and redraw from their own Update.
 */
export async function recastCharacter(
  scopedDb: ScopedDb,
  actor: Actor,
  data: {
    /**
     * The sequence whose shots are re-rendered; null from the Characters
     * page (#2017), where the recast writes the bible and voice and redraws
     * the default look's sheet, and every sequence reads stale from there.
     */
    sequenceId: string | null;
    characterId: string;
    talentId: string;
  }
) {
  const character = await requireCharacter(
    scopedDb,
    data.sequenceId,
    data.characterId
  );
  if (character.voiceOnly) {
    throw new ValidationError(
      `${character.name} is voice-only (#1585): there is no face to cast`
    );
  }
  const sequence =
    data.sequenceId === null
      ? null
      : await scopedDb.sequences.getForUser({ sequenceId: data.sequenceId });

  const talentWithSheets = await scopedDb.talent.getWithRelations(
    data.talentId
  );
  if (!talentWithSheets) {
    throw new NotFoundError('Talent not found');
  }
  assertTalentAccessible(talentWithSheets, scopedDb.teamId);

  // Filter divergent sheets out of the fallback chain — they are stale-
  // marked variants and must not back the talent's casting identity.
  const defaultSheet =
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    talentWithSheets.sheets?.find((s) => s.isDefault && !s.divergedAt) ??
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    talentWithSheets.sheets?.find((s) => !s.divergedAt);

  // Merge talent appearance with character role attributes
  const castingAttrs = buildCastingAttributes(characterToBible(character), {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    sheetMetadata: defaultSheet?.metadata ?? undefined,
    talentName: talentWithSheets.name,
    talentDescription: talentWithSheets.description ?? undefined,
    personality: talentWithSheets.personality ?? '',
    movement: talentWithSheets.movement ?? '',
  });

  const [recastLock = null] = await personLocksOf(scopedDb, [
    { id: data.characterId, talent: talentWithSheets },
  ]);
  // The talent and its appearance become ONE 'recast' bible version (#1600,
  // #2017).
  await scopedDb.characters.updateBible(
    data.sequenceId,
    data.characterId,
    {
      age: castingAttrs.age,
      gender: castingAttrs.gender,
      ethnicity: castingAttrs.ethnicity,
      physicalDescription: castingAttrs.physicalDescription,
      personality: castingAttrs.personality,
      movement: castingAttrs.movement,
      consistencyTag: castingAttrs.consistencyTag,
      // A person when the new talent is a real one, or when a sheet the
      // character wears in ANY sequence is a real person's photo (#2065):
      // the version is shared by every sequence.
      isPerson: recastLock !== null || character.isPerson,
    },
    { actorId: actor.userId, source: 'recast', talentId: data.talentId }
  );
  // Cast copies the talent's voice (#1553): its own history row, labelled
  // 'library' because that voice came from the talent, not this role's
  // design. The role's old voice is released below once nothing points at
  // it. Separate write — the voice only moves through `updateVoice`.
  if (talentWithSheets.voiceId) {
    await scopedDb.characters.updateVoice(
      data.characterId,
      {
        voiceId: talentWithSheets.voiceId,
        voiceDescription: talentWithSheets.voiceDescription,
        voicePreviews: null,
      },
      'library',
      actor.userId
    );
    await releaseReplacedVoice(
      scopedDb,
      character.voiceId,
      talentWithSheets.voiceId
    );
  }
  // Re-read rather than use the write's row: the recast snapshot needs the
  // live sheet, which resolves from the version pointer (#1419).
  const updatedCharacter = await requireCharacter(
    scopedDb,
    data.sequenceId,
    data.characterId
  );

  // The recast workflow redraws the default look's sheet (#2015) and
  // re-renders the shots that wear it. The other looks in use are redrawn
  // below, each as its own sheet run.
  const look = await scopedDb.characterLooks.ensureDefault(data.characterId);
  if (sequence === null) {
    // No shots to re-render: a plain sheet run of the default look, which
    // reads the new talent as any regenerate does.
    const { workflowRunId } = await regenerateCharacterSheet(
      scopedDb,
      actor,
      null,
      {
        characterId: data.characterId,
        lookId: look.id,
      }
    );
    return {
      character: updatedCharacter,
      talentId: data.talentId,
      sheetWorkflowRunId: workflowRunId,
      looksLeftStale: [],
      affectedShotIds: [],
    };
  }
  const affectedShotIds = await scopedDb.characters.getShotIdsForCharacter(
    sequence.id,
    data.characterId,
    { wearing: look.id }
  );
  // The shots' snapshot reads the character as this sequence casts it.
  const castCharacter = await requireCharacter(
    scopedDb,
    sequence.id,
    data.characterId
  );

  // Always generate a character sheet showing the talent in costume. The
  // claim is taken after the cast writes above, which revoke older ones.
  const { versionId: sheetVersionId } =
    await scopedDb.characterLooks.claimSheet(
      look.id,
      {
        lookVersionId: look.lookVersionId,
        bibleVersionId: updatedCharacter.selectedBibleVersionId,
        talentId: data.talentId,
      },
      { markGenerating: true }
    );

  await emitProgress(sequence.id, (channel) =>
    channel.emit('generation.character-sheet:progress', {
      characterId: data.characterId,
      lookId: look.id,
      status: 'generating',
    })
  );

  // Freeze every regenerate-shots input here, at the trigger. The workflow
  // used to rebuild this after its sheet child finished — eight live reads
  // against state the user never authorised.
  const imageModel = safeTextToImageModel(sequence.imageModel);
  const { shotSnapshots, snapshotInputHash } =
    await buildRecastRegenerateSnapshots({
      scopedDb,
      sequenceId: sequence.id,
      shotIds: affectedShotIds,
      imageModel,
      aspectRatio: sequence.aspectRatio,
      subject: { kind: 'character', character: castCharacter },
    });

  const workflowInput: RecastCharacterWorkflowInput = {
    characterDbId: data.characterId,
    lookId: look.id,
    lookVersionId: look.lookVersionId,
    lookStyling: look.styling,
    talentId: data.talentId,
    // The recast bible version the metadata below spells out (#1600).
    bibleVersionId: updatedCharacter.selectedBibleVersionId,
    characterName: character.name,
    characterMetadata: {
      characterId: characterToBible(character).characterId,
      name: character.name,
      voiceOnly: character.voiceOnly,
      isPerson: updatedCharacter.isPerson,
      rendering: updatedCharacter.rendering ?? '',
      voiceDescription: character.voiceDescription ?? '',
      ...castingAttrs,
      // The look owns clothing (#2015): the entry wears the look being drawn.
      standardClothing: look.clothing ?? '',
      looks: [
        {
          lookId: look.id,
          name: look.name,
          clothing: look.clothing ?? '',
          styling: look.styling ?? '',
        },
      ],
    },
    sequenceId: sequence.id,
    teamId: scopedDb.teamId,
    userId: actor.userId,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    referenceImageUrl: defaultSheet?.imageUrl ?? undefined,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    talentMetadata: defaultSheet?.metadata ?? undefined,
    // Image-anchored, name-free (see buildCastingAttributes): naming a
    // person + "look exactly like" trips OpenAI's likeness moderation.
    talentDescription:
      `This character must exactly match the person shown in the reference image. ${talentWithSheets.description ?? ''}`.trim(),
    reuseTalentSheet: Boolean(
      defaultSheet?.imageUrl &&
      shouldReuseTalentSheet({
        characterClothing: look.clothing,
        characterFeatures: look.styling,
        talentClothing: defaultSheet.metadata?.standardClothing,
        talentFeatures: defaultSheet.metadata?.distinguishingFeatures,
        talentPhysical: defaultSheet.metadata?.physicalDescription,
        talentDescription: talentWithSheets.description,
      })
    ),
    imageModel,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    talentSheetInputHash: defaultSheet?.inputHash ?? null,
    castTalentDescription: talentWithSheets.description,
    sheetVersionId,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    shotSnapshots,
    snapshotInputHash,
  };

  const workflowRunId = await triggerWorkflow(
    '/recast-character',
    workflowInput
  );

  // The recast redraws the default look only. Other looks are drawn from
  // that new sheet, so starting them here would copy the face that is about
  // to be replaced. Once the new sheet lands they read stale, with the shots
  // that wear them, and the next Update or Continue redraws them. Named on
  // the result so the caller can say so. (`failedLookIds` went with the
  // sheet runs this used to start for them: none is started, none fails.)
  const looksLeftStale: { lookId: string; name: string }[] = [];
  for (const other of updatedCharacter.looks) {
    if (other.isDefault || other.deletedAt) continue;
    const worn = await scopedDb.characters.getShotIdsForCharacter(
      sequence.id,
      data.characterId,
      { wearing: other.id }
    );
    if (worn.length > 0) {
      looksLeftStale.push({ lookId: other.id, name: other.name });
    }
  }

  return {
    character: updatedCharacter,
    talentId: data.talentId,
    sheetWorkflowRunId: workflowRunId,
    /**
     * Looks a scene wears other than the default. They are not redrawn by
     * the recast: they go stale once its sheet lands, and Update redraws
     * them from it.
     */
    looksLeftStale,
    // The shots actually queued — a shot with no selected image prompt is
    // dropped by the snapshot builder rather than failing the recast.
    affectedShotIds: shotSnapshots.map((s) => s.shotId),
  };
}

/**
 * Design (or re-design) a character's voice (#1553 / #1715). Inserts a
 * generating husk and keeps the current voice until that husk promotes; the
 * run saves the first take and promotes it. A second call while a live husk
 * exists no-ops (`alreadyInFlight`).
 */
export async function generateCharacterVoice(
  scopedDb: ScopedDb,
  actor: Actor,
  /** Null from the Characters page (#2017): the default analysis model. */
  sequence: Sequence | null,
  data: { characterId: string; takes: number }
) {
  if (!isElevenLabsConfigured()) {
    throw new ValidationError('Voice design is not configured');
  }
  const sequenceId = sequence?.id ?? null;
  const character = await requireCharacter(
    scopedDb,
    sequenceId,
    data.characterId
  );
  const enqueued = await enqueueCharacterVoiceDesign({
    scopedDb,
    character,
    sequenceId,
    userId: actor.userId,
    analysisModel: sequence?.analysisModel ?? null,
    takes: data.takes,
    trigger: (payload) => triggerWorkflow('/character-voice', payload),
  });
  if (!enqueued.alreadyInFlight) {
    await emitProgress(castChannelId(sequenceId, character.id), (channel) =>
      channel.emit('generation.character-voice:progress', {
        characterId: character.id,
        status: 'generating',
      })
    );
  }
  return {
    characterId: enqueued.characterId,
    workflowRunId: enqueued.workflowRunId,
    alreadyInFlight: enqueued.alreadyInFlight,
  };
}

/**
 * Cancel a voice still generating: the husk fails as cancelled and the
 * character keeps the voice it had. Data-only: the run is not terminated
 * (it may be a parent's awaited child, and a stop between save-voice and
 * persist-voice would leak the provider voice). It lands, finds its claim
 * no longer live, releases the voice and promotes nothing.
 */
export async function cancelCharacterVoice(
  scopedDb: ScopedDb,
  sequenceId: string | null,
  characterId: string
): Promise<{ cancelled: boolean }> {
  const character = await requireCharacter(scopedDb, sequenceId, characterId);
  const versionId = character.pendingPromoteVoiceVersionId;
  if (!versionId) return { cancelled: false };
  const failed = await scopedDb.characters.markVoiceClaimTerminal(
    versionId,
    'failed',
    'Cancelled'
  );
  if (!failed) return { cancelled: false };
  await emitProgress(castChannelId(sequenceId, character.id), (channel) =>
    channel.emit('generation.character-voice:progress', {
      characterId: character.id,
      status: 'failed',
      error: 'Cancelled',
    })
  );
  return { cancelled: true };
}

/** Regenerate a location's reference sheet from its current bible. */
export async function regenerateLocationSheet(
  scopedDb: ScopedDb,
  actor: Actor,
  sequence: Sequence,
  data: { locationDbId: string; imageModel?: string }
): Promise<{ locationDbId: string; workflowRunId: string }> {
  const location = await scopedDb.sequenceLocations.getById(data.locationDbId);
  if (!location || location.sequenceId !== sequence.id) {
    throw new NotFoundError('Location not found');
  }

  const payload = await buildRegenerateLocationSheetPayload({
    scopedDb,
    userId: actor.userId,
    teamId: scopedDb.teamId,
    sequence,
    location,
    imageModel: data.imageModel,
  });

  // The claim (#1113): last kickoff wins, and any edit to the location's
  // inputs before this run lands revokes it.
  const referenceVersionId = await scopedDb.sequenceLocations.claimReference(
    location.id,
    { markGenerating: true }
  );
  await emitProgress(location.sequenceId, (channel) =>
    channel.emit('generation.location-sheet:progress', {
      locationId: location.id,
      status: 'generating',
    })
  );

  let workflowRunId: string;
  try {
    const claimed: LocationSheetWorkflowInput = {
      ...payload,
      referenceVersionId,
    };
    workflowRunId = await triggerWorkflow('/location-sheet', claimed, {
      // Explicit regen must not reuse the bible-child id
      // `location-sheet:${id}` — that instance is already complete, and CF
      // would no-op a second Generate. Same pattern as generateTalentSheetFn.
    });
  } catch (error) {
    await scopedDb.sequenceLocations.failReferenceClaim(
      location.id,
      referenceVersionId,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
  return { locationDbId: location.id, workflowRunId };
}

/**
 * Recast a location with a library location: its reference image and
 * description drive the new sheet (read from the library row, never sent by
 * the caller). Triggers location reference regeneration and shot
 * regeneration.
 */
export async function recastLocation(
  scopedDb: ScopedDb,
  actor: Actor,
  data: { locationId: string; libraryLocationId: string }
) {
  const location = await scopedDb.sequenceLocations.getById(data.locationId);
  if (!location) {
    throw new NotFoundError('Location not found');
  }

  // Fetch the sequence's style for location sheet generation
  const sequence = await scopedDb.sequences.getForUser({
    sequenceId: location.sequenceId,
  });
  const style =
    sequence.styleConfig == null && sequence.styleId
      ? await scopedDb.styles.getById(sequence.styleId)
      : null;
  const styleConfig =
    sequence.styleConfig != null || style
      ? resolveSequenceStyleConfig({
          snapshot: sequence.styleConfig,
          live: style?.config,
        })
      : undefined;

  // Bind the sequence location to the library location it was recast from.
  // Without this the downstream divergence check resolves the OLD (usually
  // null) link and compares against a hash from the new one.
  const libraryLocation = await scopedDb.locations.getById(
    data.libraryLocationId
  );
  if (!libraryLocation) {
    throw new NotFoundError('Library location not found');
  }
  if (!libraryLocation.referenceImageUrl) {
    throw new ValidationError(
      'That library location has no reference image to cast from.'
    );
  }
  await scopedDb.sequenceLocations.update(data.locationId, {
    libraryLocationId: data.libraryLocationId,
  });
  // Re-read rather than use the write's row: the recast snapshot needs the
  // live reference, which resolves from the version pointer (#1419).
  const updatedLocation = await scopedDb.sequenceLocations.getById(
    data.locationId
  );
  if (!updatedLocation) {
    throw new NotFoundError('Location not found');
  }

  // Claimed after the relink above, which revokes older claims (#1113).
  const referenceVersionId = await scopedDb.sequenceLocations.claimReference(
    data.locationId,
    { markGenerating: true }
  );

  await emitProgress(location.sequenceId, (channel) =>
    channel.emit('generation.location-sheet:progress', {
      locationId: data.locationId,
      status: 'generating',
    })
  );

  const affectedShotIds =
    await scopedDb.sequenceLocations.getShotIdsForLocation(
      location.sequenceId,
      data.locationId
    );

  // Freeze every regenerate-shots input here, at the trigger. The workflow
  // used to rebuild this after its sheet child finished — eight live reads
  // against state the user never authorised.
  const imageModel = safeTextToImageModel(sequence.imageModel);
  const { shotSnapshots, snapshotInputHash } =
    await buildRecastRegenerateSnapshots({
      scopedDb,
      sequenceId: location.sequenceId,
      shotIds: affectedShotIds,
      imageModel,
      aspectRatio: sequence.aspectRatio,
      subject: { kind: 'location', location: updatedLocation },
    });

  const workflowRunId = await triggerWorkflow('/recast-location', {
    locationDbId: data.locationId,
    locationName: location.name,
    locationMetadata: toLocationMetadata(location),
    sequenceId: location.sequenceId,
    teamId: scopedDb.teamId,
    userId: actor.userId,
    referenceImageUrl: libraryLocation.referenceImageUrl,
    libraryLocationDescription: libraryLocation.description ?? undefined,
    libraryLocationId: data.libraryLocationId,
    libraryLocationReferenceHash: libraryLocation.referenceInputHash,
    referenceVersionId,
    bibleVersionId: updatedLocation.selectedBibleVersionId,
    imageModel,
    styleConfig,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    shotSnapshots,
    snapshotInputHash,
  } satisfies RecastLocationWorkflowInput);

  return {
    locationId: data.locationId,
    referenceWorkflowRunId: workflowRunId,
    // The shots actually queued — a shot with no selected image prompt is
    // dropped by the snapshot builder rather than failing the recast.
    affectedShotIds: shotSnapshots.map((s) => s.shotId),
  };
}
