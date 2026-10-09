/**
 * Finalizing a user upload as a shot's still or clip, the sequence's music,
 * or a character / location sheet (#1108 Phase 3/4) — shared by the editor's
 * server fns (`media-upload.fn.ts`) and the MCP tools. See the header of
 * `media-upload.fn.ts` for the staleness and DAG contracts.
 */
import { wearLook } from '@/cast/character-looks';
import { defaultLookFace } from '@/cast/look-sheet-face';
import {
  requireCharacterLook,
  requireLiveLook,
} from '@/cast/server/character-look';
import {
  computeCharacterSheetInputHash,
  computeLocationSheetInputHash,
  hashVisualPromptInput,
} from '@/shots/input-hash';
import { isPersonFromUploadLedger } from '@/cast/likeness';
import { resolveSheetImageModel } from '@/cast/sheet-image-model';
import {
  attestUploads,
  classifyUpload,
  likenessFromLedger,
  requireUploadRights,
  type LikenessRequestContext,
} from '@/cast/server/upload-rights';
import { StyleConfigSchema } from '@/look/style-config';
import {
  AttestationRequiredError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import {
  characterSheetTalentHashFields,
  computeStyleConfigHash,
  locationSheetBibleFields,
} from '@/cast/server/workflows/sheet-snapshots';
import { resolveCastTalent } from '@/cast/server/sheets/character-sheet-trigger';
import { toLocationMetadata } from '@/cast/server/sheets/location-sheet-trigger';
import {
  loadShotPromptContext,
  narrowShotPromptContext,
} from '@/shots/server/prompt-context';
import { computeVideoManifestInputHash } from '@/shots/input-hash';
import { shotPromptSequence, usesStartFrame } from '@/shots/use-start-frame';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { Sequence, User } from '@/platform/server/db/schema';
import type { ShotEditContext } from '@/shots/server/shot-context';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { buildVideoManifest } from '@/motion/server/render-segments';
import { getGenerationChannel } from '@/platform/realtime';
import { castChannelId } from '@/cast/cast-channel';
import { requireCharacter } from '@/cast/server/cast-edit';
import { getFrameImageUrl } from '@/shots/server/frame-image';
import {
  computeUploadedStillInputHash,
  parseUploadedStoragePath,
  UPLOAD_EXTENSIONS,
} from '@/shots/server/upload-media';
import { measureStoredMediaDuration } from '@/cast/server/sequence-elements/media-duration';
import { base64ToBytes } from '@/platform/base64';
import { USER_UPLOAD_MODEL } from '@/shots/user-upload-model';
import {
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';

import { getLogger } from '@/platform/logger';
import { uploadFile } from '#storage';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import {
  openSafeUrl,
  responseContentType,
} from '@/platform/server/api-v1/safe-fetch';
import { generateId } from '@/platform/id';
import { teamUserUploadStoragePath } from '@/cast/server/team-user-upload';
import type { PortraitAttestation } from '@/cast/upload-rights';

const logger = getLogger(['openstory', 'shots', 'media-upload']);

/** Who uploads into which sequence: the editor's sequence middleware context. */
type SequenceUploadContext = {
  scopedDb: ScopedDb;
  user: Pick<User, 'id'>;
  teamId: string;
  sequence: Sequence;
};

/** A character upload: through a sequence, or from the Characters page (#2017). */
type CastUploadContext = Omit<SequenceUploadContext, 'sequence'> & {
  sequence: Sequence | null;
};

/**
 * Resolve a finalize-time `publicUrl` to the bucket-relative `storagePath` the
 * variant tables store, or reject. A bad path here is bad INPUT (a URL outside
 * the caller's team namespace, or not one of ours) — `ValidationError` rides
 * the serialization adapter to the client as a typed 400 instead of surfacing
 * as a 500 the user can't act on.
 */
/** Exported for tests — a per-shot clip must not overwrite a multi-shot scene render. */
export function assertSingleShotSegmentForVideoUpload(
  shotsInSegment: number
): void {
  if (shotsInSegment > 1) {
    throw new ValidationError(
      'This shot shares a render with others in its scene; upload a clip for the whole scene instead of one shot'
    );
  }
}

function requireUploadedStoragePath(
  publicUrl: string,
  bucket: StorageBucket,
  teamId: string
): string {
  const storagePath = parseUploadedStoragePath(publicUrl, bucket, teamId);
  if (!storagePath) {
    throw new ValidationError(
      'Uploaded file is not in this team’s storage namespace'
    );
  }
  return storagePath;
}

/**
 * Broadcast a finished media write on the sequence's generation channel, the
 * same terminal event the generating workflow emits. Uploads are a write the
 * OTHER clients never saw start, so without this a second tab (or a
 * collaborator) keeps rendering the superseded still until something else
 * happens to refetch. Best-effort: a realtime failure must not fail the write
 * that already committed.
 */
async function emitUploadCompleted(
  sequenceId: string,
  event: 'image' | 'video',
  payload: { shotId: string; thumbnailUrl?: string; videoUrl?: string }
): Promise<void> {
  try {
    await getGenerationChannel(sequenceId).emit(
      event === 'image'
        ? 'generation.image:progress'
        : 'generation.video:progress',
      { ...payload, status: 'completed' }
    );
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }
}

/**
 * The §4.3 B image-only replace — used by the unchanged-prompt branch of
 * `replaceFrameContentFn`.
 *
 * Appends a `frame_variants.kind:'upload'` version stamped against the CURRENT
 * selected visual prompt + sheets, then `select`s it — the same repoint a
 * history pick performs, so the mirror, `image.selected` event,
 * pending-promote clear, and prompt pairing all behave identically. The visual
 * prompt is NOT touched; downstream video reads stale by manifest derivation.
 */
async function appendUploadedStill(args: {
  scopedDb: ScopedDb;
  shotId: string;
  frameId: string;
  sequenceId: string;
  scene: Scene | null;
  aspectRatio: AspectRatio;
  publicUrl: string;
  storagePath: string;
  actorId: string;
}): Promise<{
  versionId: string;
  url: string | null;
  promptVersionId: string | null;
}> {
  const { scopedDb } = args;
  const selectedPrompt = await scopedDb.framePromptVersions.getSelected(
    args.frameId
  );
  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.listWithSheets(args.sequenceId),
    scopedDb.sequenceLocations.listWithReferences(args.sequenceId),
    scopedDb.sequenceElements.list(args.sequenceId),
  ]);
  const inputHash = await computeUploadedStillInputHash({
    shotId: args.shotId,
    frameId: args.frameId,
    scene: args.scene,
    promptText: selectedPrompt?.text ?? null,
    characters,
    locations,
    elements,
    aspectRatio: args.aspectRatio,
  });

  const version = await scopedDb.frameVariants.appendUploadedVersion({
    frameId: args.frameId,
    sequenceId: args.sequenceId,
    model: USER_UPLOAD_MODEL,
    url: args.publicUrl,
    storagePath: args.storagePath,
    inputHash,
    promptVersionId: selectedPrompt?.id ?? null,
    promptText: selectedPrompt?.text ?? null,
    actorId: args.actorId,
  });
  await scopedDb.frameVariants.select(args.frameId, version.id, {
    actorId: args.actorId,
  });

  return {
    versionId: version.id,
    url: version.url,
    promptVersionId: selectedPrompt?.id ?? null,
  };
}

/**
 * Replace a frame's still, optionally together with its visual prompt, as ONE
 * atomic operation (§4.3 C): the prompt version is written first (stamped with
 * the current upstream-context hash, like `saveShotPromptFn`), the image
 * version's `inputHash` is computed against the NEW prompt text, both
 * selection pointers repoint, and everything commits in a single `db.batch()`
 * — so the image is fresh relative to the prompt it arrived with, and video
 * reads stale by manifest derivation.
 *
 * With `promptText` absent (or identical to the current selection) this is the
 * image-only path B — the prompt is untouched. There is no separate image-only
 * server fn; this is both B and C.
 */
export async function replaceFrameContent(
  context: ShotEditContext,
  data: { frameId?: string; promptText?: string; publicUrl: string }
) {
  const { shot, frame, sequence, scene, scopedDb, user, teamId } = context;

  if (data.frameId && data.frameId !== frame.id) {
    throw new ValidationError(
      'Only the shot anchor frame can be replaced (multi-frame is not supported yet)'
    );
  }

  const storagePath = requireUploadedStoragePath(
    data.publicUrl,
    STORAGE_BUCKETS.THUMBNAILS,
    teamId
  );
  // A user still must be cleared or signed on the likeness ledger (#1581).
  await requireUploadRights(scopedDb, [data.publicUrl]);

  const selectedPrompt = await scopedDb.framePromptVersions.getSelected(
    frame.id
  );

  const newPromptText = data.promptText?.trim();
  // Unchanged text is not an edit — take the image-only path so no duplicate
  // `user-edit` history row appears (mirrors saveShotPromptFn's no-op guard).
  if (!newPromptText || newPromptText === selectedPrompt?.text) {
    const result = await appendUploadedStill({
      scopedDb,
      shotId: shot.id,
      frameId: frame.id,
      sequenceId: sequence.id,
      scene,
      aspectRatio: sequence.aspectRatio,
      publicUrl: data.publicUrl,
      storagePath,
      actorId: user.id,
    });
    await emitUploadCompleted(sequence.id, 'image', {
      shotId: shot.id,
      ...(result.url ? { thumbnailUrl: result.url } : {}),
    });
    return {
      shotId: shot.id,
      versionId: result.versionId,
      promptVersionId: result.promptVersionId,
      promptChanged: false,
    } as const;
  }

  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.listWithSheets(sequence.id),
    scopedDb.sequenceLocations.listWithReferences(sequence.id),
    scopedDb.sequenceElements.list(sequence.id),
  ]);

  // Upstream-context hash for the new prompt version — best-effort, exactly
  // like saveShotPromptFn: a null hash disables staleness for this prompt
  // but never blocks the save.
  let promptInputHash: string | null = null;
  let analysisModel: string | null = null;
  if (scene) {
    try {
      const ctx = await loadShotPromptContext({
        scopedDb,
        sequence: shotPromptSequence(sequence, shot),
        scene,
        startingFrameImageUrl: await getFrameImageUrl(scopedDb, frame.id),
      });
      promptInputHash = await hashVisualPromptInput(
        narrowShotPromptContext(ctx, {
          channel: 'visual',
          prompt: newPromptText,
        })
      );
      analysisModel = ctx.analysisModel;
    } catch (error) {
      logger.warn(
        `replaceFrameContent: uncomputable prompt hash for shot ${shot.id}; recording with null hash`,
        { err: error }
      );
    }
  }

  // Image hash against the NEW prompt text — the §4.3 C freshness rule.
  const imageInputHash = await computeUploadedStillInputHash({
    shotId: shot.id,
    frameId: frame.id,
    scene,
    promptText: newPromptText,
    characters,
    locations,
    elements,
    aspectRatio: sequence.aspectRatio,
  });

  const { promptVersion, imageVersion } =
    await scopedDb.frameVariants.replaceContent({
      frameId: frame.id,
      sequenceId: sequence.id,
      actorId: user.id,
      prompt: {
        text: newPromptText,
        inputHash: promptInputHash,
        analysisModel,
        createdBy: user.id,
      },
      image: {
        model: USER_UPLOAD_MODEL,
        url: data.publicUrl,
        storagePath,
        inputHash: imageInputHash,
      },
    });

  await emitUploadCompleted(sequence.id, 'image', {
    shotId: shot.id,
    ...(imageVersion.url ? { thumbnailUrl: imageVersion.url } : {}),
  });

  return {
    shotId: shot.id,
    versionId: imageVersion.id,
    promptVersionId: promptVersion.id,
    promptChanged: true,
  } as const;
}

/**
 * Finalize an uploaded clip as the shot's video: materialize the shot's render
 * segment if needed, adopt the clip's real duration, append a `video_variants`
 * version whose manifest snapshots the CURRENT selected motion-prompt /
 * frame-version pointers (so a later prompt edit or still replace diverges the
 * manifest → stale), then `select` it — the same repoint + `video.selected`
 * event the motion pipeline uses.
 */
export async function setShotVideoFromUpload(
  context: ShotEditContext,
  data: { publicUrl: string; durationSeconds?: number }
) {
  const { shot, frame, sequence, scopedDb, user, teamId } = context;

  const storagePath = requireUploadedStoragePath(
    data.publicUrl,
    STORAGE_BUCKETS.VIDEOS,
    teamId
  );

  const renderSegmentId = await scopedDb.renderSegments.ensureForShot(shot);

  // A clip uploaded "for this shot" is written as the SEGMENT's render, so on
  // a multi-shot segment (#910 scene render) it would silently replace the
  // siblings' video too — and segment staleness wouldn't flag it, because the
  // manifest we write only names this shot. Refuse rather than corrupt.
  const shotsInSegment =
    await scopedDb.shots.countInRenderSegment(renderSegmentId);
  assertSingleShotSegmentForVideoUpload(shotsInSegment);

  // Adopt the real duration BEFORE hashing: the manifest folds `durationMs`
  // in, so writing the shot afterwards would leave the clip instantly stale
  // against its own render. The browser measured it on upload; a caller that
  // sent none (MCP) gets it read from the file instead.
  const durationSeconds =
    data.durationSeconds ??
    (await measureStoredMediaDuration(
      `${STORAGE_BUCKETS.VIDEOS}/${storagePath}`
    ));
  const durationMs = durationSeconds
    ? Math.round(durationSeconds * 1000)
    : (shot.durationMs ?? 3000);
  if (durationMs !== shot.durationMs) {
    await scopedDb.shots.update(shot.id, { durationMs });
  }

  const [selectedMotion, selectedImage] = await Promise.all([
    scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
    scopedDb.frameVariants.getSelected(frame.id),
  ]);
  const shotUsesStartFrame = usesStartFrame(shot, sequence);
  const manifest = buildVideoManifest([
    {
      shotId: shot.id,
      motionPromptVersionId: selectedMotion?.id ?? null,
      // A reference-only shot's frame pointer is null even when a still
      // exists (`assembleSequenceSegments` compares against null), so pinning
      // the still here would make the upload read Stale for ever and let
      // "Update all" re-render over it.
      frameVersionId: shotUsesStartFrame ? (selectedImage?.id ?? null) : null,
      // An upload rendered from nothing we know of; stamp the shot's mode
      // so it agrees with the pointer above.
      usesStartFrame: shotUsesStartFrame,
      durationMs,
      audioClipIds: [],
      audioSourceKey: null,
      dialogueKey: null,
      referenceKeys: [],
    },
  ]);
  const inputHash = await computeVideoManifestInputHash(
    manifest,
    USER_UPLOAD_MODEL
  );

  const version = await scopedDb.videoVariants.appendUploadedVersion({
    renderSegmentId,
    sequenceId: sequence.id,
    shotId: shot.id,
    model: USER_UPLOAD_MODEL,
    manifest,
    url: data.publicUrl,
    storagePath,
    inputHash,
    actorId: user.id,
  });
  await scopedDb.videoVariants.select(shot.id, version.id, {
    actorId: user.id,
  });

  await emitUploadCompleted(sequence.id, 'video', {
    shotId: shot.id,
    ...(version.url ? { videoUrl: version.url } : {}),
  });

  return {
    shotId: shot.id,
    versionId: version.id,
    videoUrl: version.url,
    durationSeconds: durationSeconds ?? null,
  };
}

/**
 * Finalize an uploaded audio file as the sequence's score: append it as a
 * completed `user-upload` track and point the sequence at it (#1115), so
 * generated tracks stay switchable alongside it. Tracks are append-only, so
 * an earlier upload stays a row of its own — never a silent delete.
 *
 * `inputHash` is deliberately null (§4.4 "untracked" escape hatch): the user
 * chose this exact track — a prompt edit should not push regeneration over it.
 */
export async function setSequenceMusicFromUpload(
  context: SequenceUploadContext,
  data: { publicUrl: string; durationSeconds?: number }
) {
  const { sequence, scopedDb, user, teamId } = context;

  const storagePath = requireUploadedStoragePath(
    data.publicUrl,
    STORAGE_BUCKETS.AUDIO,
    teamId
  );

  const variant = await scopedDb.sequenceVariants.appendUploadedMusic({
    sequenceId: sequence.id,
    model: USER_UPLOAD_MODEL,
    url: data.publicUrl,
    storagePath,
    prompt: sequence.musicPrompt,
    tags: sequence.musicTags,
    durationSeconds:
      data.durationSeconds ??
      (await measureStoredMediaDuration(
        `${STORAGE_BUCKETS.AUDIO}/${storagePath}`
      )),
  });
  const withMusicSet = await scopedDb.sequences.getById(sequence.id);
  if (!withMusicSet) throw new NotFoundError('Sequence not found');
  // An uploaded score the sequence then excludes from the mix is a dead end
  // the user gets no feedback about — choosing a track IS opting in.
  const updatedSequence = withMusicSet.includeMusic
    ? withMusicSet
    : await scopedDb.sequences.update({
        id: sequence.id,
        includeMusic: true,
      });
  await scopedDb.sequenceEvents.record({
    sequenceId: sequence.id,
    actorId: user.id,
    kind: 'music.uploaded',
    targetType: 'sequence',
    targetId: sequence.id,
    summary: 'Uploaded music track',
    data: { variantId: variant.id },
  });

  try {
    await getGenerationChannel(sequence.id).emit('generation.audio:progress', {
      status: 'completed',
      model: variant.model,
      ...(updatedSequence.musicUrl
        ? { audioUrl: updatedSequence.musicUrl }
        : {}),
    });
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }

  return { sequence: updatedSequence, variantId: variant.id };
}

/**
 * Style-config hash + image model resolved the way sheet verify does after
 * this upload is selected. The new version's `model` is `user-upload` (not a
 * t2i id), so verify skips it and falls through to the sequence default —
 * hashing the upload against a prior generated model would look stale the
 * moment the pointer moved. Stills re-stale because `applyConvergent`
 * selects a new version id.
 */
async function resolveSheetHashContext(
  scopedDb: ScopedDb,
  sequence: {
    styleId: string | null;
    imageModel: string | null;
  }
): Promise<{ styleConfigHash: string; imageModel: string }> {
  const style = sequence.styleId
    ? await scopedDb.styles.getById(sequence.styleId)
    : null;
  const styleConfig = style ? StyleConfigSchema.parse(style.config) : null;
  return {
    styleConfigHash: await computeStyleConfigHash(styleConfig),
    imageModel: resolveSheetImageModel({
      sequenceImageModel: sequence.imageModel,
    }),
  };
}

/**
 * Finalize an uploaded character sheet: append a completed version, select it,
 * stamp parent + version with the CURRENT bible + talent sheet + style + model
 * hash, and log a `sheet.uploaded` event. No generation is triggered. Stills
 * re-stale because they hash the new selected version id.
 */
export async function setCharacterSheetFromUpload(
  context: CastUploadContext,
  data: {
    characterId: string;
    /** The look the sheet is of (#2015). A character id names its default. */
    lookId: string;
    publicUrl: string;
  }
) {
  const { scopedDb, sequence, user } = context;
  const sequenceId = sequence?.id ?? null;
  const storagePath = requireUploadedStoragePath(
    data.publicUrl,
    STORAGE_BUCKETS.CHARACTERS,
    context.teamId
  );
  await requireUploadRights(scopedDb, [data.publicUrl]);
  const owner = await requireCharacter(scopedDb, sequenceId, data.characterId);
  // The sheet is one look's (#2015): the hash below reads that look's
  // clothing and styling, as a generated sheet's would.
  const look = requireLiveLook(
    await requireCharacterLook(scopedDb, owner, data.lookId)
  );
  // An upload is the user's own image: it needs no face to be drawn from, so
  // it is allowed before the default look has a sheet (decided 2026-10-07).
  // It is stamped with whatever face exists now, null when none, so it reads
  // stale once a (new) default sheet lands, as a generated look would.
  const face = look.isDefault ? null : defaultLookFace(owner.looks);
  const character = wearLook(owner, look);
  const isPerson = isPersonFromUploadLedger(
    character.isPerson,
    await likenessFromLedger(scopedDb, data.publicUrl)
  );

  // Same upstream resolution the character-sheet workflow uses: from no
  // sequence, the default model (#2017).
  const cast = await resolveCastTalent(scopedDb, character.talentId);
  const imageModel = resolveSheetImageModel({
    sequenceImageModel: sequence?.imageModel ?? null,
  });
  const inputHash = await computeCharacterSheetInputHash({
    characterBible: {
      name: character.name,
      age: character.age ?? '',
      gender: character.gender,
      ethnicity: character.ethnicity,
      physicalDescription: character.physicalDescription,
      standardClothing: character.standardClothing,
      rendering: character.rendering,
      consistencyTag: character.consistencyTag,
    },
    styling: character.styling,
    faceSheetVersionId: face === null ? null : face.versionId,
    talentSheetHash: cast.talentSheetInputHash ?? null,
    talent: characterSheetTalentHashFields(cast),
    // The current shape reads no style (#2017).
    styleConfigHash: null,
    imageModel,
  });

  // The upload's likeness verdict is a bible edit (#1600): its own version
  // row, only when it moved.
  if (isPerson !== character.isPerson) {
    await scopedDb.characters.updateBible(
      sequenceId,
      character.id,
      { isPerson },
      { actorId: user.id, source: 'edit' }
    );
  }
  // Append + select: parent + version share the current-inputs hash so later
  // bible/style/model edits re-stale the sheet. The selected version id is
  // what stills hash, so this upload re-stales dependent stills even when
  // inputs didn't change.
  const { version: variant } =
    await scopedDb.characterSheetVariants.applyConvergent({
      lookId: look.id,
      url: data.publicUrl,
      storagePath,
      inputHash,
      model: USER_UPLOAD_MODEL,
    });
  const updated = await requireCharacter(scopedDb, sequenceId, character.id);
  // A write from no sequence writes no event (#2017).
  if (sequence) {
    await scopedDb.sequenceEvents.record({
      sequenceId: sequence.id,
      actorId: user.id,
      kind: 'sheet.uploaded',
      targetType: 'character',
      targetId: character.id,
      summary: `Uploaded sheet for ${character.name}`,
      data: {
        characterId: character.id,
        lookId: look.id,
        variantId: variant.id,
      },
    });
  }
  try {
    await getGenerationChannel(castChannelId(sequenceId, character.id)).emit(
      'generation.character-sheet:progress',
      {
        characterId: character.id,
        lookId: look.id,
        status: 'completed',
        sheetImageUrl: data.publicUrl,
      }
    );
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }
  return updated;
}

/**
 * Finalize an uploaded location reference: append a completed version, select
 * it, stamp parent + version with the current bible + library ref + style +
 * model hash. Stills re-stale via the new selected version id.
 */
export async function setLocationSheetFromUpload(
  context: SequenceUploadContext,
  data: { locationDbId: string; publicUrl: string }
) {
  const { scopedDb, sequence, user } = context;
  const storagePath = requireUploadedStoragePath(
    data.publicUrl,
    STORAGE_BUCKETS.LOCATIONS,
    context.teamId
  );
  await requireUploadRights(scopedDb, [data.publicUrl]);
  const location = await scopedDb.sequenceLocations.getById(data.locationDbId);
  if (!location || location.sequenceId !== sequence.id) {
    throw new NotFoundError('Location not found');
  }

  let libraryLocationReferenceHash: string | null = null;
  if (location.libraryLocationId) {
    const libraryLocation = await scopedDb.locations.getById(
      location.libraryLocationId
    );
    libraryLocationReferenceHash = libraryLocation?.referenceInputHash ?? null;
  }
  const { styleConfigHash, imageModel } = await resolveSheetHashContext(
    scopedDb,
    sequence
  );
  const inputHash = await computeLocationSheetInputHash({
    locationBible: locationSheetBibleFields(toLocationMetadata(location)),
    libraryLocationReferenceHash,
    styleConfigHash,
    imageModel,
  });

  const { version: variant } =
    await scopedDb.locationSheetVariants.applyConvergent({
      locationDbId: location.id,
      url: data.publicUrl,
      storagePath,
      inputHash,
      model: USER_UPLOAD_MODEL,
    });
  const updated = await scopedDb.sequenceLocations.getById(location.id);
  if (!updated) throw new NotFoundError('Location not found');
  await scopedDb.sequenceEvents.record({
    sequenceId: sequence.id,
    actorId: user.id,
    kind: 'sheet.uploaded',
    targetType: 'location',
    targetId: location.id,
    summary: `Uploaded reference for ${location.name}`,
    data: { locationDbId: location.id, variantId: variant.id },
  });
  try {
    await getGenerationChannel(sequence.id).emit(
      'generation.location-sheet:progress',
      {
        locationId: location.id,
        status: 'completed',
        referenceImageUrl: data.publicUrl,
      }
    );
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Upload from an agent (MCP `upload_media`): a hosted URL or inline bytes,
// stored where the editor's presigned PUT for the same use would land, then
// held to the same likeness gate before any attach can use it.
// ---------------------------------------------------------------------------

/** What an upload is for: picks the bucket, the folder and the allowed types. */
export const UPLOAD_USES = [
  'shot_image',
  'shot_video',
  'music',
  'character_sheet',
  'location_sheet',
  'element',
  'studio',
] as const;
export type UploadUse = (typeof UPLOAD_USES)[number];

/** Media type → stored extension, for every type any use accepts. */
const UPLOAD_MEDIA_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
};

/**
 * Extensions per use: the editor's upload surfaces (`UPLOAD_EXTENSIONS`).
 * Elements take MP3/WAV and MP4/MOV only — the browser re-encodes M4A/OGG to
 * WAV first, which a server upload cannot, and WebM is refused by the models
 * (#1559).
 */
const ELEMENT_EXTENSIONS = [
  ...UPLOAD_EXTENSIONS.image,
  'mp3',
  'wav',
  'mp4',
  'mov',
];
const USE_EXTENSIONS: Record<UploadUse, readonly string[]> = {
  shot_image: UPLOAD_EXTENSIONS.image,
  character_sheet: UPLOAD_EXTENSIONS.image,
  location_sheet: UPLOAD_EXTENSIONS.image,
  shot_video: UPLOAD_EXTENSIONS.video,
  music: UPLOAD_EXTENSIONS.audio,
  element: ELEMENT_EXTENSIONS,
  // A Studio reference, start/end frame or clip; the same types as elements.
  studio: ELEMENT_EXTENSIONS,
};

const IMAGE_EXTENSIONS = new Set<string>(UPLOAD_EXTENSIONS.image);

/** Inline bytes ride in the tool call's JSON, so they stay small. */
export const MAX_INLINE_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Images are read whole (the classifier and the cap); media is streamed. */
const MAX_URL_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_URL_MEDIA_BYTES = 500 * 1024 * 1024;

function uploadTarget(
  use: UploadUse,
  teamId: string,
  sequenceId: string | null,
  ext: string
): { bucket: StorageBucket; path: string } {
  const id = generateId();
  if (use === 'studio') {
    // The composer's key (`presignTalentUploadFn`), which list_studio_uploads reads.
    return {
      bucket: STORAGE_BUCKETS.TALENT,
      path: teamUserUploadStoragePath(teamId, id, ext),
    };
  }
  if (!sequenceId) {
    throw new ValidationError(`A ${use} upload needs sequenceId.`);
  }
  const inSequence = `teams/${teamId}/sequences/${sequenceId}`;
  switch (use) {
    case 'shot_image':
      return {
        bucket: STORAGE_BUCKETS.THUMBNAILS,
        path: `${inSequence}/uploads/${id}.${ext}`,
      };
    case 'shot_video':
      return {
        bucket: STORAGE_BUCKETS.VIDEOS,
        path: `${inSequence}/uploads/${id}.${ext}`,
      };
    case 'music':
      return {
        bucket: STORAGE_BUCKETS.AUDIO,
        path: `${inSequence}/music/${id}.${ext}`,
      };
    case 'character_sheet':
      return {
        bucket: STORAGE_BUCKETS.CHARACTERS,
        path: `${inSequence}/uploads/${id}.${ext}`,
      };
    case 'location_sheet':
      return {
        bucket: STORAGE_BUCKETS.LOCATIONS,
        path: `${inSequence}/uploads/${id}.${ext}`,
      };
    case 'element':
      // `presignElementUploadFn`'s key: `elements/<team>/<sequence>/<id>`.
      return {
        bucket: STORAGE_BUCKETS.ELEMENTS,
        path: `${teamId}/${sequenceId}/${id}.${ext}`,
      };
  }
}

function extensionFor(use: UploadUse, mediaType: string): string {
  const ext = UPLOAD_MEDIA_TYPES[mediaType];
  if (!ext || !USE_EXTENSIONS[use].includes(ext)) {
    throw new ValidationError(
      `A ${use} upload must be ${USE_EXTENSIONS[use].join(', ')}; got ${mediaType || 'no type'}.`
    );
  }
  return ext;
}

export type UploadSource = { url: string } | { data: string; mimeType: string };

/**
 * Store an agent's file for `use` in this sequence (or the team's Studio) and
 * check it for a real person (images only, as every editor surface does): the
 * classifier's verdict is recorded on the likeness ledger, and a real person
 * needs the portrait sign-off, which is recorded here. Returns the stored
 * `/r2/` URL the attach functions take.
 */
export async function storeUpload(args: {
  scopedDb: ScopedDb;
  userId: string;
  /** Null only for a Studio upload, which belongs to the team. */
  sequenceId: string | null;
  use: UploadUse;
  source: UploadSource;
  filename?: string;
  portraitAttestation?: Omit<PortraitAttestation, 'url'>;
  request: LikenessRequestContext;
}): Promise<{
  url: string;
  mediaType: string;
  bytes: number | null;
  rights: 'cleared' | 'signed' | 'not_checked';
}> {
  const { scopedDb, use, source } = args;
  const teamId = scopedDb.teamId;
  let stored: { url: string; mediaType: string; bytes: number | null };

  if ('data' in source) {
    const mediaType = source.mimeType.trim().toLowerCase();
    const ext = extensionFor(use, mediaType);
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(source.data);
    } catch {
      throw new ValidationError('data is not valid base64.');
    }
    if (bytes.byteLength === 0) {
      throw new ValidationError('data is empty.');
    }
    if (bytes.byteLength > MAX_INLINE_UPLOAD_BYTES) {
      throw new ValidationError(
        'Inline data is over 8 MB; host the file and send its url instead.'
      );
    }
    const { bucket, path } = uploadTarget(use, teamId, args.sequenceId, ext);
    const result = await uploadFile(bucket, path, bytes, {
      contentType: mediaType,
    });
    stored = { url: result.publicUrl, mediaType, bytes: bytes.byteLength };
  } else {
    const res = await openSafeUrl(source.url, 'Upload');
    const mediaType = responseContentType(res);
    let ext: string;
    try {
      ext = extensionFor(use, mediaType);
    } catch (error) {
      void res.body?.cancel();
      throw error;
    }
    // The length is required up front: an image is read whole, so the cap
    // must hold before the read, and a clip is streamed into the bucket, never
    // held in the isolate (`uploadResponse` buffers without a length).
    const declared = Number(res.headers.get('content-length'));
    if (!(Number.isFinite(declared) && declared > 0)) {
      void res.body?.cancel();
      throw new ValidationError(
        'The host did not say how large the file is (no Content-Length); host it somewhere that does.'
      );
    }
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const cap = isImage ? MAX_URL_IMAGE_BYTES : MAX_URL_MEDIA_BYTES;
    if (declared > cap) {
      void res.body?.cancel();
      throw new ValidationError(
        `The file is over ${cap / 1024 / 1024} MB, the limit for this upload.`
      );
    }
    const { bucket, path } = uploadTarget(use, teamId, args.sequenceId, ext);
    if (isImage) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > cap) {
        throw new ValidationError(
          `The file is over ${cap / 1024 / 1024} MB, the limit for this upload.`
        );
      }
      const result = await uploadFile(bucket, path, bytes, {
        contentType: mediaType,
      });
      stored = { url: result.publicUrl, mediaType, bytes: bytes.byteLength };
    } else {
      const result = await uploadResponse(res, bucket, path, {
        contentType: mediaType,
      });
      stored = { url: result.publicUrl, mediaType, bytes: declared };
    }
  }

  if (!stored.mediaType.startsWith('image/')) {
    return { ...stored, rights: 'not_checked' };
  }
  // The likeness gate (#1581), as the editor's `classifyUploadFn` and the
  // public API's ingest run it: the classifier decides, never the caller.
  const rights = await classifyUpload({
    scopedDb,
    userId: args.userId,
    url: stored.url,
    filename: args.filename,
    request: args.request,
  });
  if (rights.status === 'cleared') return { ...stored, rights: 'cleared' };
  if (rights.status === 'needs_portrait') {
    if (!args.portraitAttestation) {
      throw new AttestationRequiredError(
        'This image shows a real person: send portraitAttestation (the portrait-rights statement version and your authorization basis) to upload it.'
      );
    }
    await attestUploads(
      scopedDb,
      [{ url: stored.url, ...args.portraitAttestation }],
      args.request
    );
  }
  return { ...stored, rights: 'signed' };
}
