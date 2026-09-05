/**
 * Bucket-relative folder a *draft* element upload lands in, before any
 * sequence exists to own it (`elements/<teamId>/uploads/<uploadId>.<ext>`).
 *
 * It is a permanent key, not a staging area (#1471). One draft upload can be
 * claimed by N sequences — multi-model creation fans out one create per
 * analysis model — so the object is shared and immutable, and every
 * `sequence_elements` row simply points at it. Nothing moves or deletes it,
 * which is what keeps a second sequence (or a second tab still rendering the
 * draft) from finding a 404 where its thumbnail used to be.
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
