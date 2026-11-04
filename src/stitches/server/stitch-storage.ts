/**
 * Where a shared stitch's files live (#2127): `stitches/<organizationId>/<id>/<file>`.
 * The CLI names a file `<n>.<ext>`; `create_stitch` mints a ULID. The organization id
 * leads the path, which is what `resolveUploadTarget` checks, so the CLI's
 * PUTs can only land inside the organization that created the row.
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
  organizationId: string,
  id: string
): StitchCut {
  return mapCutMedia(cut, (name) =>
    getPublicUrl(
      STORAGE_BUCKETS.STITCHES,
      `${organizationId}/${id}/${name.slice(MEDIA_PREFIX.length)}`
    )
  );
}

/** The bucket path of a stored stitch URL: `<organizationId>/<id>/<file>`. */
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
export function stitchUploadHref(organizationId: string, id: string): string {
  return `/api/storage/upload?bucket=${STORAGE_BUCKETS.STITCHES}&path=${organizationId}/${id}/{name}&contentType={type}`;
}
