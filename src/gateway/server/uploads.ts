/** `POST /api/v1/gateway/uploads`: a self-hosted install's input file, stored under the caller and checked for a real person (#2438). */

import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { outputExtension } from '@/gateway/server/storage';
import { withPlatformLlmKey } from '@/gateway/server/platform-credentials';
import { readIdempotencyKey } from '@/gateway/server/submit-job';
import { sha256Hex } from '@/platform/compliance/hash';
import { ValidationError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  getPublicUrl,
  STORAGE_BUCKETS,
  toShareableUrl,
} from '@/platform/server/storage/buckets';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import { fileExists } from '#storage';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MEDIA_TYPE = /^(image|video|audio)\//;

/**
 * The Idempotency-Key names the file: the same key returns the same URL and
 * never rewrites the object, so a retried submit sends the same body. The URL
 * is absolute and is the one the check ran on, so a submit finds its verdict.
 */
export async function storeGatewayUpload(
  scopedDb: ScopedDb,
  request: Request
): Promise<{ url: string }> {
  const key = readIdempotencyKey(request.headers);
  if (!key) throw new ValidationError('Idempotency-Key is required');
  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (!contentType || !MEDIA_TYPE.test(contentType)) {
    throw new ValidationError(
      'Content-Type must be an image, video or audio type'
    );
  }
  const extension = outputExtension('', contentType);
  if (extension === 'bin') {
    throw new ValidationError(`Unsupported Content-Type ${contentType}`);
  }
  const length = Number(request.headers.get('content-length'));
  if (!(Number.isInteger(length) && length > 0 && length <= MAX_UPLOAD_BYTES)) {
    throw new ValidationError('Content-Length is required and at most 500 MB');
  }
  const bucket = STORAGE_BUCKETS.GATEWAY_UPLOADS;
  const path = `${scopedDb.organizationId}/${await sha256Hex(key)}.${extension}`;
  if (await fileExists(bucket, path)) {
    void request.body?.cancel();
  } else {
    await uploadResponse(
      new Response(request.body, {
        headers: { 'content-length': String(length) },
      }),
      bucket,
      path,
      { contentType }
    );
  }
  const url = toShareableUrl(
    getPublicUrl(bucket, path),
    new URL(request.url).origin
  );
  await requireCheckedUploadRights(withPlatformLlmKey(scopedDb), [url], {
    ipAddress: request.headers.get('cf-connecting-ip'),
    userAgent: request.headers.get('user-agent'),
  });
  return { url };
}
