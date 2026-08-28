/**
 * Server functions for `sequence_exports`: the table of MP4 snapshots the user
 * explicitly created via the browser-side export pipeline (see
 * `src/lib/sequence-player/export.ts`).
 *
 * Three handlers:
 *   - `requestSequenceExportUploadUrlFn` — reserves an R2 path so the browser
 *     can stream the finalized MP4 directly to storage.
 *   - `commitSequenceExportFn`           — verifies the team-scoped path, then
 *     records a new `sequence_exports` row pointing at it.
 *   - `listSequenceExportsFn`            — returns newest-first list for UI.
 *
 * Unlike the old merged-video flow there is no status state machine on the
 * sequence row itself: every export is just an additional row. If the browser
 * pipeline fails mid-upload, the reservation simply has no commit and the row
 * is never inserted; cleanup of orphaned R2 objects is a separate concern.
 */

import { getSignedUploadUrl } from '#storage';
import { generateId } from '@/lib/db/id';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { STORAGE_BUCKETS, getPublicUrl } from '@/lib/storage/buckets';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';

const EXPORT_FILENAME_SUFFIX = '_openstory.mp4';
const EXPORT_CONTENT_TYPE = 'video/mp4';

function buildExportPath(teamId: string, sequenceId: string): string {
  const shortHash = generateId().slice(-8);
  return `teams/${teamId}/sequences/${sequenceId}/exports/${shortHash}${EXPORT_FILENAME_SUFFIX}`;
}

function expectedExportPathPrefix(teamId: string, sequenceId: string): string {
  return `teams/${teamId}/sequences/${sequenceId}/exports/`;
}

export const requestSequenceExportUploadUrlFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    const path = buildExportPath(context.teamId, context.sequence.id);
    const upload = await getSignedUploadUrl(
      STORAGE_BUCKETS.VIDEOS,
      path,
      EXPORT_CONTENT_TYPE
    );
    return {
      uploadUrl: upload.uploadUrl,
      publicUrl: upload.publicUrl,
      path,
      contentType: EXPORT_CONTENT_TYPE,
    };
  });

export const commitSequenceExportFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        path: z.string().min(1),
        durationSeconds: z.number().positive().nullable().optional(),
        sourceShotsHash: z.string().nullable().optional(),
        sourceMusicVariantId: ulidSchema.nullable().optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const expectedPrefix = expectedExportPathPrefix(
      context.teamId,
      context.sequence.id
    );
    if (!data.path.startsWith(expectedPrefix)) {
      throw new Error('Invalid export path for this sequence/team');
    }
    if (!data.path.endsWith(EXPORT_FILENAME_SUFFIX)) {
      throw new Error(`Export path must end with ${EXPORT_FILENAME_SUFFIX}`);
    }

    const publicUrl = getPublicUrl(STORAGE_BUCKETS.VIDEOS, data.path);
    const row = await context.scopedDb.sequenceExports.insert({
      sequenceId: context.sequence.id,
      url: publicUrl,
      storagePath: data.path,
      durationSeconds: data.durationSeconds ?? null,
      sourceShotsHash: data.sourceShotsHash ?? null,
      sourceMusicVariantId: data.sourceMusicVariantId ?? null,
    });

    return { id: row.id, url: row.url, path: row.storagePath };
  });

export const listSequenceExportsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return await context.scopedDb.sequenceExports.listBySequence(
      context.sequence.id
    );
  });
