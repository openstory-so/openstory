/**
 * Publish a stitch the CLI uploaded (#2127): the step that makes the row a
 * page. It runs after the last PUT and checks what the raw upload route does
 * not: that every file the cut names is in the bucket, and that every image
 * has passed the real-person check (`classifyUpload`, the same gate
 * `storeUpload` runs for `create_stitch`). A real person needs the portrait
 * sign-off, recorded here as it is for `upload_media`.
 */

import { fileExists } from '#storage';
import {
  attestUploads,
  classifyUpload,
  type LikenessRequestContext,
} from '@/cast/server/upload-rights';
import type { PortraitAttestation } from '@/cast/upload-rights';
import {
  AttestationRequiredError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Stitch } from '@/platform/server/db/schema';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { mapCutMedia, type MediaRole } from '@/stitches/cut';
import { storedStitchPath } from '@/stitches/server/stitch-storage';

export async function publishStitch(args: {
  scopedDb: ScopedDb;
  userId: string;
  id: string;
  portraitAttestation: Omit<PortraitAttestation, 'url'> | null;
  request: LikenessRequestContext;
}): Promise<Stitch> {
  const stitch = await args.scopedDb.stitches.getById(args.id);
  if (!stitch) throw new NotFoundError('This stitch does not exist');
  if (stitch.publishedAt !== null) return stitch;

  // Every file once; every file that any slot shows as a picture, whatever
  // other slot names it, so a still cannot hide behind a video slot.
  const files = new Set<string>();
  const images = new Set<string>();
  mapCutMedia(stitch.cut, (url, role: MediaRole) => {
    files.add(url);
    if (role === 'image') images.add(url);
    return url;
  });
  for (const url of files) {
    const path = storedStitchPath(url);
    if (!(await fileExists(STORAGE_BUCKETS.STITCHES, path))) {
      throw new ValidationError(
        `${path.slice(path.lastIndexOf('/') + 1)} was not uploaded.`
      );
    }
  }
  for (const url of images) {
    const rights = await classifyUpload({
      scopedDb: args.scopedDb,
      userId: args.userId,
      url,
      request: args.request,
    });
    if (rights.status !== 'needs_portrait') continue;
    if (!args.portraitAttestation) {
      throw new AttestationRequiredError(
        'A still shows a real person: send portraitAttestation (the portrait-rights statement version and your authorization basis) to publish it.'
      );
    }
    await attestUploads(
      args.scopedDb,
      [{ url, ...args.portraitAttestation }],
      args.request
    );
  }
  const published = await args.scopedDb.stitches.publish(args.id);
  if (published) return published;
  // The guarded UPDATE found no unpublished row: a concurrent publish got
  // there first. Then the row is published, and that is the answer.
  const now = await args.scopedDb.stitches.getById(args.id);
  if (now?.publishedAt) return now;
  throw new Error('stitch publish updated no row');
}
