import {
  STORAGE_BUCKETS,
  getPublicUrl,
} from '@/platform/server/storage/buckets';

/**
 * Folder a *draft* element upload lands in: bucket-relative
 * `<teamId>/uploads/<uploadId>.<ext>`, i.e. R2 key
 * `elements/<teamId>/uploads/<uploadId>.<ext>`.
 *
 * It is a permanent key, not a staging area (#1471). One draft upload can be
 * claimed by N sequences — creation fans out one sequence per selected
 * analysis model — so the object is shared and nothing moves or deletes it.
 * That is what stops a second sequence (or a second tab still rendering the
 * draft) finding a 404 where its thumbnail used to be.
 *
 * Nothing reclaims abandoned drafts, and an R2 lifecycle rule is NOT the fix:
 * every promoted element points into this prefix forever, so an age-based rule
 * would delete live objects. Reclaiming has to be row-driven — a sweep that
 * joins against `sequence_elements.imagePath`.
 */
export const DRAFT_ELEMENT_UPLOAD_PREFIX = 'uploads';

/**
 * Sequence-element storage paths must live exactly under
 * `elements/<teamId>/`. `startsWith` alone accepts traversal artifacts like
 * `elements/<myTeamId>/../<otherTeamId>/x` — R2 stores keys literally so the
 * practical blast radius is small, but rejecting `..` and `//` segments closes
 * the namespace boundary explicitly.
 */
export function isValidElementStoragePath(
  path: string,
  teamId: string
): boolean {
  const prefix = `elements/${teamId}/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  if (rest.length === 0) return false;
  return !rest.split('/').some((seg) => seg === '' || seg === '..');
}

/**
 * Bucket-relative form of a validated `elements/…` key — what the storage
 * helpers take, since they re-prefix the bucket themselves.
 */
export function elementBucketPath(path: string): string {
  return path.slice('elements/'.length);
}

/**
 * Public URL for a validated element key. Always derive the URL a row stores
 * from the path rather than taking it off the payload: a client that supplies
 * both can otherwise point `imageUrl` at a host it controls while `imagePath`
 * still looks legitimate.
 */
export function elementImageUrlFromPath(path: string): string {
  return getPublicUrl(STORAGE_BUCKETS.ELEMENTS, elementBucketPath(path));
}
