/**
 * Copy a stored image into a new R2 key. Used when a character reuses a
 * talent sheet (talent bucket → characters bucket) and when an uploaded
 * library sheet is stored under its own sheet key (same talent bucket).
 *
 * Only origin-relative `/r2/…` (or legacy absolute `/r2/`) URLs are accepted
 * — never fetch an arbitrary http(s) URL.
 */

import { readStorageObject, uploadFile } from '#storage';
import {
  r2KeyFromUrl,
  STORAGE_BUCKETS,
  type StorageBucket,
  type UploadResult,
} from '@/lib/storage/buckets';

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

export async function copyStoredImage(params: {
  sourceUrl: string;
  destBucket: StorageBucket;
  destPath: string;
  contentType?: string;
}): Promise<UploadResult> {
  const key = requireStoredKey(params.sourceUrl);
  const object = await readStorageObject(key);
  if (!object) {
    throw new Error(`Source image not found: ${params.sourceUrl}`);
  }
  return uploadFile(params.destBucket, params.destPath, object.bytes, {
    contentType: params.contentType || object.contentType || 'image/png',
  });
}
