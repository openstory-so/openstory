/**
 * Where a shared stitch's files live (#2127): `stitches/<teamId>/<id>/<file>`.
 * The CLI names a file `<n>.<ext>`; `create_stitch` mints a ULID. The team id
 * leads the path, which is what `resolveUploadTarget` checks, so the CLI's
 * PUTs can only land inside the team that created the row.
 */

import {
  getPublicUrl,
  STORAGE_BUCKETS,
} from '@/platform/server/storage/buckets';
import { mapCutMedia, type StitchCut } from '@/stitches/cut';

const MEDIA_PREFIX = 'media/';
const STORED_PREFIX = `/r2/${STORAGE_BUCKETS.STITCHES}/`;

/** The stored cut: every `media/<n>.<ext>` becomes its `/r2/...` URL. */
export function storedStitchCut(
  cut: StitchCut,
  teamId: string,
  id: string
): StitchCut {
  return mapCutMedia(cut, (name) =>
    getPublicUrl(
      STORAGE_BUCKETS.STITCHES,
      `${teamId}/${id}/${name.slice(MEDIA_PREFIX.length)}`
    )
  );
}

/** The bucket path of a stored stitch URL: `<teamId>/<id>/<file>`. */
export function storedStitchPath(url: string): string {
  if (!url.startsWith(STORED_PREFIX)) {
    throw new Error(`Not a stored stitch URL: ${url}`);
  }
  return url.slice(STORED_PREFIX.length);
}

/**
 * The templated upload link the CLI fills per file: `{name}` is the bundle
 * name without `media/`, `{type}` its media type.
 */
export function stitchUploadHref(teamId: string, id: string): string {
  return `/api/storage/upload?bucket=${STORAGE_BUCKETS.STITCHES}&path=${teamId}/${id}/{name}&contentType={type}`;
}
