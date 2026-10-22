/**
 * Cast generation shared by the editor's server fns and the MCP tools
 * (#1979): regenerate a character or location sheet, replace a sequence's
 * location with another of the team's, design a character's voice and
 * cancel that design. Each spends credits through the workflow it triggers.
 */
import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/models/models';
import { sheetStartedSummary } from '@/sequences/model-label';
import { castChannelId, locationChannelId } from '@/cast/cast-channel';
import { getGenerationChannel } from '@/platform/realtime';
import { requireCharacter, requireLocation } from '@/cast/server/cast-edit';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { recordTriggerFailure } from '@/sequences/server/db/sequence-events';
import type {
  CharacterSheetWorkflowInput,
  LocationSheetWorkflowInput,
  RecastLocationWorkflowInput,
} from '@/platform/server/workflow/types';
import { buildRecastRegenerateSnapshots } from '@/cast/server/workflows/recast-snapshot';
import { enqueueCharacterVoiceDesign } from '@/cast/server/voice/enqueue-character-voice';
import { isElevenLabsConfigured } from '@/models/server/elevenlabs-config';
import { lookSheetFaceRefusal } from '@/cast/look-sheet-face';
import { buildRegenerateCharacterSheetPayload } from '@/cast/server/sheets/character-sheet-trigger';
import {
  requireCharacterLook,
  requireLiveLook,
} from '@/cast/server/character-look';
import { buildRegenerateLocationSheetPayload } from '@/cast/server/sheets/location-sheet-trigger';
import { ValidationError } from '@/platform/errors';
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
 * Regenerate the character sheet from the current bible. Does not
 * regenerate shots — stills go stale by derivation once the new version
 * is selected.
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
      activity: payload.sequenceId
        ? {
            sequenceId: payload.sequenceId,
            actorId: actor.userId,
            // The model the sheet workflow renders with when none is set.
            summary: sheetStartedSummary(
              character.name,
              payload.imageModel ?? DEFAULT_IMAGE_MODEL
            ),
          }
        : null,
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
      // Omit dedup so each click is a new run.
    });
  } catch (error) {
    await scopedDb.characterLooks.failSheetClaim(
      payload.lookId,
      sheetVersionId,
      error instanceof Error ? error.message : String(error)
    );
    if (payload.sequenceId) {
      await recordTriggerFailure(scopedDb.sequenceEvents, {
        sequenceId: payload.sequenceId,
        actorId: actor.userId,
        kind: 'run.failed',
        targetType: 'sequence',
        targetId: payload.sequenceId,
        summary: 'Character sheet failed',
      });
    }
    throw error;
  }
  return { characterId: character.id, workflowRunId };
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

/**
 * Regenerate a location's sheet from its current bible and photos. The
 * location is the team's: the new sheet is every sequence's.
 */
export async function regenerateLocationSheet(
  scopedDb: ScopedDb,
  actor: Actor,
  /** Null from the Locations page (#1695): no sequence model. */
  sequence: Sequence | null,
  data: { locationDbId: string; imageModel?: string }
): Promise<{ locationDbId: string; workflowRunId: string }> {
  const location = await requireLocation(
    scopedDb,
    sequence?.id ?? null,
    data.locationDbId
  );

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
  const referenceVersionId = await scopedDb.locations.claimReference(
    location.id,
    {
      markGenerating: true,
      activity: sequence
        ? {
            sequenceId: sequence.id,
            actorId: actor.userId,
            summary: sheetStartedSummary(
              location.name,
              payload.imageModel ?? DEFAULT_IMAGE_MODEL
            ),
          }
        : null,
    }
  );
  await emitProgress(
    locationChannelId(payload.sequenceId, location.id),
    (channel) =>
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
      // would no-op a second Generate. Omit dedup so each click is a new run.
    });
  } catch (error) {
    await scopedDb.locations.failReferenceClaim(
      location.id,
      referenceVersionId,
      error instanceof Error ? error.message : String(error)
    );
    if (payload.sequenceId) {
      await recordTriggerFailure(scopedDb.sequenceEvents, {
        sequenceId: payload.sequenceId,
        actorId: actor.userId,
        kind: 'run.failed',
        targetType: 'sequence',
        targetId: payload.sequenceId,
        summary: 'Location sheet failed',
      });
    }
    throw error;
  }
  return { locationDbId: location.id, workflowRunId };
}

/**
 * Replace the location a sequence uses with another of the team's (#1695):
 * the link is re-pointed, then the shots now set at the new location are
 * re-rendered. No sheet is drawn and no claim is taken: the sequence reads
 * the other location's sheet as it is.
 *
 * The link moves before the run starts. If the trigger throws, the error
 * surfaces and the shots read stale against the new location.
 */
export async function recastLocation(
  scopedDb: ScopedDb,
  actor: Actor,
  data: { sequenceId: string; locationId: string; withLocationId: string }
) {
  const sequence = await scopedDb.sequences.getForUser({
    sequenceId: data.sequenceId,
  });
  const replacement = await requireLocation(
    scopedDb,
    null,
    data.withLocationId
  );
  if (
    replacement.referenceStatus !== 'completed' ||
    !replacement.referenceImageUrl
  ) {
    throw new ValidationError(
      `${replacement.name} has no reference image to cast from.`
    );
  }
  const location = await scopedDb.locations.replace(
    sequence.id,
    data.locationId,
    data.withLocationId,
    { actorId: actor.userId }
  );

  const affectedShotIds = await scopedDb.locations.getShotIdsForLocation(
    sequence.id,
    location.id
  );

  // Freeze every regenerate-shots input here, at the trigger, after the link
  // moved: the snapshots read the new location's sheet.
  const imageModel = safeTextToImageModel(sequence.imageModel);
  const { shotSnapshots, snapshotInputHash } =
    await buildRecastRegenerateSnapshots({
      scopedDb,
      sequenceId: sequence.id,
      shotIds: affectedShotIds,
      imageModel,
      aspectRatio: sequence.aspectRatio,
      subject: null,
    });

  const workflowRunId = await triggerWorkflow('/recast-location', {
    locationDbId: location.id,
    locationName: location.name,
    sequenceId: sequence.id,
    teamId: scopedDb.teamId,
    userId: actor.userId,
    imageModel,
    aspectRatio: sequence.aspectRatio,
    resolution: sequence.resolution,
    shotSnapshots,
    snapshotInputHash,
  } satisfies RecastLocationWorkflowInput);

  return {
    /** The location the sequence now uses (`locations.id`). */
    locationId: location.id,
    workflowRunId,
    // The shots actually queued — a shot with no selected image prompt is
    // dropped by the snapshot builder rather than failing the recast.
    affectedShotIds: shotSnapshots.map((s) => s.shotId),
  };
}
