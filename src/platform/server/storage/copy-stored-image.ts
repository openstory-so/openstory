/**
 * Stored `/r2/…` keys. Composer uploads still land under the `talent` bucket
 * prefix. Only origin-relative `/r2/…` URLs are accepted — never an arbitrary
 * http(s) URL.
 */

import { r2KeyFromUrl, STORAGE_BUCKETS } from './buckets';

export function requireStoredKey(url: string): string {
  const key = r2KeyFromUrl(url);
  if (!key) {
    throw new Error(`Source image is not a stored /r2/ URL: ${url}`);
  }
  return key;
}

export function isTeamTalentStoredUrl(url: string, teamId: string): boolean {
  const key = r2KeyFromUrl(url);
  return key?.startsWith(`${STORAGE_BUCKETS.TALENT}/${teamId}/`) ?? false;
}
