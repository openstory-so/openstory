/**
 * `create_stitch` (#2127): a shared cut made from files the agent hands over
 * as URLs or inline bytes, no CLI. Each distinct source is stored once under
 * `stitches/<team>/<id>/` through `storeUpload` (the same fetch guard, size
 * caps and real-person check `upload_media` runs), then the cut is written
 * with the stored URLs. The id is minted first so the stored paths carry it.
 */

import { generateId } from '@/platform/id';
import { ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { LikenessRequestContext } from '@/cast/server/upload-rights';
import type { PortraitAttestation } from '@/cast/upload-rights';
import {
  MAX_INLINE_UPLOAD_BYTES,
  storeUpload,
  type UploadSource,
} from '@/shots/server/media-upload';
import { cutSchemaOf, mapCutMedia, type MediaRole } from '@/stitches/cut';
import { z } from 'zod';

/** A file for one slot: a public URL the server fetches, or inline bytes. */
const stitchMediaSourceSchema = z.union([
  z.strictObject({ url: z.url().max(2048) }),
  z.strictObject({
    data: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_INLINE_UPLOAD_BYTES * 4) / 3) + 4)
      .describe('Base64 file bytes (no data: prefix).'),
    mimeType: z.string().min(1).max(100),
  }),
]);

export const stitchSourcesCutSchema = cutSchemaOf(stitchMediaSourceSchema);
export type StitchSourcesCut = z.infer<typeof stitchSourcesCutSchema>;

const ROLE_TYPE: Record<MediaRole, string> = {
  video: 'video/',
  image: 'image/',
  audio: 'audio/',
};

export async function createStitchFromSources(args: {
  scopedDb: ScopedDb;
  userId: string;
  cut: StitchSourcesCut;
  portraitAttestation?: Omit<PortraitAttestation, 'url'>;
  request: LikenessRequestContext;
}): Promise<{ id: string; files: number }> {
  const id = generateId();
  // One upload per distinct source, whatever slots name it.
  const slots = new Map<string, { source: UploadSource; role: MediaRole }>();
  mapCutMedia(args.cut, (source, role) => {
    const key = JSON.stringify(source);
    const seen = slots.get(key);
    if (seen && seen.role !== role) {
      throw new ValidationError(
        `The same file is used as ${seen.role} and ${role}.`
      );
    }
    if (!seen) slots.set(key, { source, role });
    return key;
  });
  const stored = new Map<string, string>();
  for (const [key, { source, role }] of slots) {
    const file = await storeUpload({
      scopedDb: args.scopedDb,
      userId: args.userId,
      sequenceId: null,
      use: 'stitch',
      stitchId: id,
      source,
      portraitAttestation: args.portraitAttestation,
      request: args.request,
    });
    if (!file.mediaType.startsWith(ROLE_TYPE[role])) {
      throw new ValidationError(
        `A ${role} slot got ${file.mediaType}${'url' in source ? ` from ${source.url}` : ''}.`
      );
    }
    stored.set(key, file.url);
  }
  const cut = mapCutMedia(args.cut, (source) => {
    const url = stored.get(JSON.stringify(source));
    if (!url) throw new Error('stitch source was not stored');
    return url;
  });
  // Every file went through storeUpload's checks, so the row is born published.
  await args.scopedDb.stitches.create({ id, cut, publishedAt: new Date() });
  return { id, files: stored.size };
}
