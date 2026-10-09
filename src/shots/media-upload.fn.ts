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
import { ValidationError } from '@/platform/errors';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import {
  resolveUploadExtension,
  uploadExtensionList,
  type UploadMediaSurface,
} from '@/shots/server/upload-media';
import {
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import { getMimeTypeFromExtension } from '@/platform/server/storage/file';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  castAccessMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import {
  replaceFrameContent,
  setCharacterSheetFromUpload,
  setLocationSheetFromUpload,
  setSequenceMusicFromUpload,
  setShotVideoFromUpload,
} from '@/shots/server/media-upload';
import { generateId } from '@/platform/id';

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

// Finalize — the logic lives in `@/shots/server/media-upload`, shared with MCP.

const replaceFrameContentInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  /** Optional; must be the shot's anchor frame (multi-frame is Phase 5). */
  frameId: ulidSchema.optional(),
  promptText: z.string().optional(),
  publicUrl: mediaUrlSchema,
});
export const replaceFrameContentFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(replaceFrameContentInput))
  .handler(({ context, data }) => replaceFrameContent(context, data));

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
export const setShotVideoFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .validator(zodValidator(setShotVideoFromUploadInput))
  .handler(({ context, data }) => setShotVideoFromUpload(context, data));

const setSequenceMusicFromUploadInput = z.object({
  sequenceId: ulidSchema,
  publicUrl: mediaUrlSchema,
  /** Decoded track duration, when the client measured it. */
  durationSeconds: z.number().positive().optional(),
});
export const setSequenceMusicFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setSequenceMusicFromUploadInput))
  .handler(({ context, data }) => setSequenceMusicFromUpload(context, data));

// ---------------------------------------------------------------------------
// Manual character / location sheet upload on SEQUENCE entities (#1108 Phase 4
// — the sequence-side mirror of the library `manual_upload` source).
// ---------------------------------------------------------------------------

// `sequenceId` null is the Characters page (#2017): the same upload, stored
// under the team, with no sequence event or channel.
const characterSheetPresignInput = z.object({
  sequenceId: ulidSchema.nullable(),
  characterId: ulidSchema,
  filename: z.string().min(1),
});

export const presignCharacterSheetUploadFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(characterSheetPresignInput))
  .handler(async ({ context, data }) => {
    return signedUpload(
      STORAGE_BUCKETS.CHARACTERS,
      context.sequence
        ? `teams/${context.teamId}/sequences/${context.sequence.id}/characters/${data.characterId}/${generateId()}`
        : `teams/${context.teamId}/characters/${data.characterId}/${generateId()}`,
      data.filename,
      'image'
    );
  });

const setCharacterSheetInput = z.object({
  sequenceId: ulidSchema.nullable(),
  characterId: ulidSchema,
  // The look the sheet is of (#2015); the default look when omitted.
  lookId: ulidSchema.optional(),
  publicUrl: mediaUrlSchema,
});
export const setCharacterSheetFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([castAccessMiddleware])
  .validator(zodValidator(setCharacterSheetInput))
  .handler(({ context, data }) =>
    setCharacterSheetFromUpload(context, {
      ...data,
      // No look named: the default look, whose id is the character's.
      lookId: data.lookId ?? data.characterId,
    })
  );

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
export const setLocationSheetFromUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setLocationSheetInput))
  .handler(({ context, data }) => setLocationSheetFromUpload(context, data));
