/**
 * User-upload keys for talent and location (#1634). Same contract as
 * elements (#1471): the object lands in `<teamId>/uploads/<id>.<ext>` and
 * stays there. The likeness ledger is the gate, not a folder move.
 *
 * `temp/` is accepted on attach so a tab that presigned before the cutover
 * can still finalize. New presigns only write `uploads/`.
 */

import { fileExists } from '#storage';
import { NotFoundError, ValidationError } from '@/platform/errors';
import {
  STORAGE_BUCKETS,
  getPathFromUrl,
} from '@/platform/server/storage/buckets';

const TEAM_USER_UPLOAD_PREFIX = 'uploads';
const LEGACY_TEMP_PREFIX = 'temp';

const USER_UPLOAD_BUCKETS = [
  STORAGE_BUCKETS.TALENT,
  STORAGE_BUCKETS.LOCATIONS,
] as const;

export type UserUploadBucket = (typeof USER_UPLOAD_BUCKETS)[number];

export function isTeamUserUploadUrl(
  url: string,
  bucket: UserUploadBucket,
  teamId: string
): boolean {
  const uploads = `/r2/${bucket}/${teamId}/${TEAM_USER_UPLOAD_PREFIX}/`;
  const temp = `/r2/${bucket}/${teamId}/${LEGACY_TEMP_PREFIX}/`;
  return url.startsWith(uploads) || url.startsWith(temp);
}

export function teamUserUploadStoragePath(
  teamId: string,
  uploadId: string,
  ext: string
): string {
  return `${teamId}/${TEAM_USER_UPLOAD_PREFIX}/${uploadId}.${ext}`;
}

/**
 * Prove a client-supplied talent/location URL may back a row: this team's
 * `uploads/` (or leftover `temp/`), actually present in R2.
 */
export async function assertTeamUserUploadAttachable(params: {
  url: string;
  bucket: UserUploadBucket;
  teamId: string;
}): Promise<{ path: string; url: string }> {
  const { url, bucket, teamId } = params;
  if (!isTeamUserUploadUrl(url, bucket, teamId)) {
    throw new ValidationError('Invalid storage path');
  }
  const path = getPathFromUrl(url, bucket);
  if (!(await fileExists(bucket, path))) {
    throw new NotFoundError(
      'This upload is no longer available in storage. Re-upload it and try again.'
    );
  }
  return { path, url };
}
