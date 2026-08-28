/**
 * Manual media inject server fns (#1108 Phase 3) — user-provided stills,
 * clips, and music as first-class versions of the same append-only stores the
 * generation pipeline writes.
 *
 * Upload transport reuses the presign pattern (`getSignedUploadUrl` → client
 * PUT to `/api/storage/upload` → finalize fn), like elements/talent. Each
 * finalize appends a version (`frame_variants.kind:'upload'` /
 * `video_variants` / music primary slot), stamps its `inputHash` from CURRENT
 * inputs with the same builders the workflows use (§8 hash-stamp consistency),
 * selects it, and logs a `*.uploaded` event.
 *
 * DAG contract (plan §4.3): an image-only replace clears video by derivation
 * (the render manifest still names the previous frame version) and never
 * touches the visual prompt; the atomic prompt+image replace
 * (`replaceFrameContentFn`) commits both versions in ONE `db.batch()` with the
 * image hashed against the NEW prompt text, so the image is never observed
 * stale relative to the prompt it arrived with.
 */

import { getSignedUploadUrl } from '#storage';
import {
  computeCharacterSheetInputHash,
  computeLocationSheetInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import { resolveSheetImageModel } from '@/lib/sheets/sheet-image-model';
import { StyleConfigSchema } from '@/lib/db/schema';
import { NotFoundError } from '@/lib/errors';
import { computeStyleConfigHash } from '@/lib/workflows/sheet-snapshots';
import {
  loadShotPromptContext,
  narrowShotPromptContext,
} from '@/lib/ai/prompt-context';
import { computeVideoManifestInputHash } from '@/lib/ai/input-hash';
import { generateId } from '@/lib/db/id';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { ValidationError } from '@/lib/errors';
import { buildVideoManifest } from '@/lib/motion/render-segments';
import { getGenerationChannel } from '@/lib/realtime';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { getFrameImageUrl } from '@/lib/shots/frame-image';
import {
  computeUploadedStillInputHash,
  parseUploadedStoragePath,
  resolveUploadExtension,
  uploadExtensionList,
  USER_UPLOAD_MODEL,
  type UploadMediaSurface,
} from '@/lib/shots/upload-media';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/storage/buckets';
import { getMimeTypeFromExtension } from '@/lib/utils/file';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { shotAccessMiddleware, sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'media-upload']);

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
 * Extension for an upload, rejecting anything outside the surface's allow-list.
 * The PUT route trusts its `contentType` query param, so this is the only
 * server-side control over what lands in a bucket the worker serves
 * same-origin — an `.svg` still would be a stored-XSS vector on `/r2/`.
 */
function requireUploadExtension(
  filename: string,
  surface: UploadMediaSurface
): string {
  const ext = resolveUploadExtension(filename, surface);
  if (!ext) {
    throw new ValidationError(
      `Unsupported ${surface} file type. Accepted: ${uploadExtensionList(surface)}`
    );
  }
  return ext;
}

function signedUpload(
  bucket: StorageBucket,
  pathWithoutExt: string,
  filename: string,
  surface: UploadMediaSurface
) {
  const ext = requireUploadExtension(filename, surface);
  return getSignedUploadUrl(
    bucket,
    `${pathWithoutExt}.${ext}`,
    getMimeTypeFromExtension(ext)
  );
}

// ---------------------------------------------------------------------------
// Presign — one per media surface; all write under the caller team's prefix
// (`teams/<teamId>/…`), which `resolveUploadTarget` enforces at PUT time.
// ---------------------------------------------------------------------------

const shotPresignInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  filename: z.string().min(1),
});

export const presignFrameImageUploadFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotPresignInput))
  .handler(async ({ context, data }) => {
    // Same directory generated stills land in (uploadImageToStorage).
    return signedUpload(
      STORAGE_BUCKETS.THUMBNAILS,
      `teams/${context.teamId}/sequences/${context.sequence.id}/frames/${context.shot.id}/${generateId()}`,
      data.filename,
      'image'
    );
  });

export const presignShotVideoUploadFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(shotPresignInput))
  .handler(async ({ context, data }) => {
    return signedUpload(
      STORAGE_BUCKETS.VIDEOS,
      `teams/${context.teamId}/sequences/${context.sequence.id}/frames/${context.shot.id}/${generateId()}`,
      data.filename,
      'video'
    );
  });

export const presignSequenceMusicUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({ sequenceId: ulidSchema, filename: z.string().min(1) })
    )
  )
  .handler(async ({ context, data }) => {
    return signedUpload(
      STORAGE_BUCKETS.AUDIO,
      `teams/${context.teamId}/sequences/${context.sequence.id}/music/${generateId()}`,
      data.filename,
      'audio'
    );
  });

// ---------------------------------------------------------------------------
// Still upload — §4.3 B (image-only) is the unchanged-prompt branch of
// `replaceFrameContentFn` below.
// ---------------------------------------------------------------------------

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
 * selected visual prompt + sheets, then `select`s it — the exact repoint
 * `setImageFromVariantFn` performs, so the mirror, `image.selected` event,
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

// ---------------------------------------------------------------------------
// Atomic prompt + still replace — §4.3 C (image-only when prompt is unchanged)
// ---------------------------------------------------------------------------

const replaceFrameContentInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  /** Optional; must be the shot's anchor frame (multi-frame is Phase 5). */
  frameId: ulidSchema.optional(),
  promptText: z.string().optional(),
  publicUrl: mediaUrlSchema,
});

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
export const replaceFrameContentFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(replaceFrameContentInput))
  .handler(async ({ context, data }) => {
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
          sequence,
          scene,
          startingFrameImageUrl: await getFrameImageUrl(scopedDb, frame.id),
        });
        promptInputHash = await computeVisualPromptInputHash(
          narrowShotPromptContext(ctx)
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
  });

// ---------------------------------------------------------------------------
// Video upload
// ---------------------------------------------------------------------------

const setShotVideoFromUploadInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  publicUrl: mediaUrlSchema,
  /**
   * Decoded clip duration, when the client measured it. The uploaded bytes —
   * not the shot's previous plan — are the truth for how long this shot now
   * runs, so it re-snaps `shots.durationMs` before the manifest is built.
   */
  durationSeconds: z.number().positive().optional(),
});

/**
 * Finalize an uploaded clip as the shot's video: materialize the shot's render
 * segment if needed, adopt the clip's real duration, append a `video_variants`
 * version whose manifest snapshots the CURRENT selected motion-prompt /
 * frame-version pointers (so a later prompt edit or still replace diverges the
 * manifest → stale), then `select` it — the same repoint + `video.selected`
 * event the motion pipeline uses.
 */
export const setShotVideoFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(setShotVideoFromUploadInput))
  .handler(async ({ context, data }) => {
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
    // against its own render.
    const durationMs = data.durationSeconds
      ? Math.round(data.durationSeconds * 1000)
      : (shot.durationMs ?? 3000);
    if (durationMs !== shot.durationMs) {
      await scopedDb.shots.update(shot.id, { durationMs });
    }

    const [selectedMotion, selectedImage] = await Promise.all([
      scopedDb.shotPromptVersions.getSelectedMotion(shot.id),
      scopedDb.frameVariants.getSelected(frame.id),
    ]);
    const manifest = buildVideoManifest([
      {
        shotId: shot.id,
        motionPromptVersionId: selectedMotion?.id ?? null,
        frameVersionId: selectedImage?.id ?? null,
        durationMs,
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

    return { shotId: shot.id, versionId: version.id, videoUrl: version.url };
  });

// ---------------------------------------------------------------------------
// Music upload
// ---------------------------------------------------------------------------

const setSequenceMusicFromUploadInput = z.object({
  sequenceId: ulidSchema,
  publicUrl: mediaUrlSchema,
  /** Decoded track duration, when the client measured it. */
  durationSeconds: z.number().positive().optional(),
});

/**
 * Finalize an uploaded audio file as the sequence's score: write it into the
 * `user-upload` primary slot of `sequence_music_variants` and copy it onto
 * `sequences.music*` via the existing non-destructive `setMusicFromVariant`
 * path, so generated tracks stay switchable alongside it.
 *
 * Every upload shares the one `user-upload` slot, so the previous upload is
 * RETIRED (not overwritten) first — it stays in the alternates list where
 * Promote restores it. Versions are append-only; a second upload must not be a
 * silent delete of the first.
 *
 * `inputHash` is deliberately null (§4.4 "untracked" escape hatch): nothing
 * verifies track-level music staleness today, and the user chose this exact
 * track — a prompt edit should not push regeneration over it.
 */
export const setSequenceMusicFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setSequenceMusicFromUploadInput))
  .handler(async ({ context, data }) => {
    const { sequence, scopedDb, user, teamId } = context;

    const storagePath = requireUploadedStoragePath(
      data.publicUrl,
      STORAGE_BUCKETS.AUDIO,
      teamId
    );

    const retired = await scopedDb.sequenceVariants.retireMusicPrimary(
      sequence.id,
      USER_UPLOAD_MODEL
    );
    const variant = await scopedDb.sequenceVariants.upsertMusicPrimary({
      sequenceId: sequence.id,
      model: USER_UPLOAD_MODEL,
      url: data.publicUrl,
      storagePath,
      prompt: sequence.musicPrompt ?? null,
      tags: sequence.musicTags ?? null,
      durationSeconds: data.durationSeconds ?? null,
      status: 'completed',
      generatedAt: new Date(),
      error: null,
      inputHash: null,
    });
    const withMusicSet = await scopedDb.sequenceVariants.setMusicFromVariant(
      variant.id
    );
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
      data: { variantId: variant.id, retiredVariantId: retired?.id ?? null },
    });

    try {
      await getGenerationChannel(sequence.id).emit(
        'generation.audio:progress',
        {
          status: 'completed',
          model: variant.model,
          ...(updatedSequence.musicUrl
            ? { audioUrl: updatedSequence.musicUrl }
            : {}),
        }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { sequence: updatedSequence, variantId: variant.id };
  });

// ---------------------------------------------------------------------------
// Manual character / location sheet upload on SEQUENCE entities (#1108 Phase 4
// — the sequence-side mirror of the library `manual_upload` source).
// ---------------------------------------------------------------------------

const characterSheetPresignInput = z.object({
  sequenceId: ulidSchema,
  characterId: ulidSchema,
  filename: z.string().min(1),
});

export const presignCharacterSheetUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(characterSheetPresignInput))
  .handler(async ({ context, data }) => {
    return signedUpload(
      STORAGE_BUCKETS.CHARACTERS,
      `teams/${context.teamId}/sequences/${context.sequence.id}/characters/${data.characterId}/${generateId()}`,
      data.filename,
      'image'
    );
  });

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

const setCharacterSheetInput = z.object({
  sequenceId: ulidSchema,
  characterId: ulidSchema,
  publicUrl: mediaUrlSchema,
});

/**
 * Finalize an uploaded character sheet: append a completed version, select it,
 * stamp parent + version with the CURRENT bible + talent sheet + style + model
 * hash, and log a `sheet.uploaded` event. No generation is triggered. Stills
 * re-stale because they hash the new selected version id.
 */
export const setCharacterSheetFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setCharacterSheetInput))
  .handler(async ({ context, data }) => {
    const { scopedDb, sequence, user } = context;
    const storagePath = requireUploadedStoragePath(
      data.publicUrl,
      STORAGE_BUCKETS.CHARACTERS,
      context.teamId
    );
    const character = await scopedDb.characters.getById(data.characterId);
    if (!character || character.sequenceId !== sequence.id) {
      throw new NotFoundError('Character not found');
    }

    // Same upstream resolution the character-sheet workflow uses: the matched
    // talent's default convergent sheet hash, else null.
    let talentSheetHash: string | null = null;
    if (character.talentId) {
      const talent = await scopedDb.talent.getWithRelations(character.talentId);
      const convergent = talent?.sheets.filter((s) => !s.divergedAt) ?? [];
      const defaultSheet = convergent.find((s) => s.isDefault) ?? convergent[0];
      talentSheetHash = defaultSheet?.inputHash ?? null;
    }
    const { styleConfigHash, imageModel } = await resolveSheetHashContext(
      scopedDb,
      sequence
    );
    const inputHash = await computeCharacterSheetInputHash({
      characterBible: {
        name: character.name,
        age: character.age ?? '',
        gender: character.gender,
        ethnicity: character.ethnicity,
        physicalDescription: character.physicalDescription,
        standardClothing: character.standardClothing,
        distinguishingFeatures: character.distinguishingFeatures,
        consistencyTag: character.consistencyTag,
      },
      talentSheetHash,
      styleConfigHash,
      imageModel,
    });

    // Append + select: parent + version share the current-inputs hash so later
    // bible/style/model edits re-stale the sheet. The selected version id is
    // what stills hash, so this upload re-stales dependent stills even when
    // inputs didn't change.
    const { character: updated, version: variant } =
      await scopedDb.characterSheetVariants.applyConvergent({
        characterId: character.id,
        url: data.publicUrl,
        storagePath,
        inputHash,
        model: USER_UPLOAD_MODEL,
      });
    await scopedDb.sequenceEvents.record({
      sequenceId: sequence.id,
      actorId: user.id,
      kind: 'sheet.uploaded',
      targetType: 'character',
      targetId: character.id,
      summary: `Uploaded sheet for ${character.name}`,
      data: { characterId: character.id, variantId: variant.id },
    });
    try {
      await getGenerationChannel(sequence.id).emit(
        'generation.character-sheet:progress',
        {
          characterId: character.id,
          status: 'completed',
          sheetImageUrl: data.publicUrl,
        }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }
    return updated;
  });

const locationSheetPresignInput = z.object({
  sequenceId: ulidSchema,
  locationDbId: ulidSchema,
  filename: z.string().min(1),
});

export const presignLocationSheetUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(locationSheetPresignInput))
  .handler(async ({ context, data }) => {
    return signedUpload(
      STORAGE_BUCKETS.LOCATIONS,
      `teams/${context.teamId}/sequences/${context.sequence.id}/locations/${data.locationDbId}/${generateId()}`,
      data.filename,
      'image'
    );
  });

const setLocationSheetInput = z.object({
  sequenceId: ulidSchema,
  locationDbId: ulidSchema,
  publicUrl: mediaUrlSchema,
});

/**
 * Finalize an uploaded location reference: append a completed version, select
 * it, stamp parent + version with the current bible + library ref + style +
 * model hash. Stills re-stale via the new selected version id.
 */
export const setLocationSheetFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setLocationSheetInput))
  .handler(async ({ context, data }) => {
    const { scopedDb, sequence, user } = context;
    const storagePath = requireUploadedStoragePath(
      data.publicUrl,
      STORAGE_BUCKETS.LOCATIONS,
      context.teamId
    );
    const location = await scopedDb.sequenceLocations.getById(
      data.locationDbId
    );
    if (!location || location.sequenceId !== sequence.id) {
      throw new NotFoundError('Location not found');
    }

    let libraryLocationReferenceHash: string | null = null;
    if (location.libraryLocationId) {
      const libraryLocation = await scopedDb.locations.getById(
        location.libraryLocationId
      );
      libraryLocationReferenceHash =
        libraryLocation?.referenceInputHash ?? null;
    }
    const { styleConfigHash, imageModel } = await resolveSheetHashContext(
      scopedDb,
      sequence
    );
    const inputHash = await computeLocationSheetInputHash({
      locationBible: {
        name: location.name,
        description: location.description,
      },
      libraryLocationReferenceHash,
      styleConfigHash,
      imageModel,
    });

    const { location: updated, version: variant } =
      await scopedDb.locationSheetVariants.applyConvergent({
        locationDbId: location.id,
        url: data.publicUrl,
        storagePath,
        inputHash,
        model: USER_UPLOAD_MODEL,
      });
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
  });
