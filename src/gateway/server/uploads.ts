/** `POST /api/v1/gateway/uploads`: a self-hosted install's input file, stored under the caller and checked for a real person (#2438). */

import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { outputExtension } from '@/gateway/server/storage';
import { withPlatformLlmKey } from '@/gateway/server/platform-credentials';
import { readIdempotencyKey } from '@/gateway/server/submit-job';
import { sha256Hex } from '@/platform/compliance/hash';
import { ValidationError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import type { ScopedDb } from '@/platform/server/db/scoped';
import {
  buildR2Key,
  getPublicUrl,
  STORAGE_BUCKETS,
  StorageFileExistsError,
  toShareableUrl,
} from '@/platform/server/storage/buckets';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import { deleteFile, readStorageObject, uploadFile } from '#storage';

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MEDIA_TYPE = /^(image|video|audio)\//;

const BUCKET = STORAGE_BUCKETS.GATEWAY_UPLOADS;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Where the Idempotency-Key's file id is kept: create-only, so a key names one file forever. */
async function pointerPath(organizationId: string, key: string) {
  return `${organizationId}/keys/${await sha256Hex(key)}`;
}

async function readPointer(path: string): Promise<string | null> {
  const stored = await readStorageObject(buildR2Key(BUCKET, path));
  if (!stored) return null;
  const [id, extension] = new TextDecoder().decode(stored.bytes).split('.');
  if (!id || !ULID.test(id) || !extension || !/^[a-z0-9]+$/.test(extension)) {
    throw new Error(`Malformed gateway upload pointer at ${path}`);
  }
  return `${id}.${extension}`;
}

/**
 * Each file is stored once under a fresh ULID with a create-only write, so
 * the bytes the likeness check classified are the bytes the URL serves. The
 * Idempotency-Key maps to that id (a create-only pointer), never to a path a
 * second writer could replace. A file that fails the check is deleted.
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
  const { organizationId } = scopedDb;
  const origin = new URL(request.url).origin;
  const urlOf = (file: string) =>
    toShareableUrl(getPublicUrl(BUCKET, `${organizationId}/${file}`), origin);
  const check = (url: string) =>
    requireCheckedUploadRights(withPlatformLlmKey(scopedDb), [url], {
      ipAddress: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
    });

  const pointer = await pointerPath(organizationId, key);
  const existing = await readPointer(pointer);
  if (existing) {
    void request.body?.cancel();
    const url = urlOf(existing);
    // The pointer is written only after a pass; this answers from the stored verdict.
    await check(url);
    return { url };
  }

  const file = `${generateId()}.${extension}`;
  await uploadResponse(
    new Response(request.body, {
      headers: { 'content-length': String(length) },
    }),
    BUCKET,
    `${organizationId}/${file}`,
    { contentType, upsert: false }
  );
  const url = urlOf(file);
  try {
    await check(url);
  } catch (error) {
    await deleteFile(BUCKET, `${organizationId}/${file}`);
    throw error;
  }
  try {
    await uploadFile(BUCKET, pointer, new TextEncoder().encode(file), {
      contentType: 'text/plain',
      upsert: false,
    });
    return { url };
  } catch (error) {
    if (!(error instanceof StorageFileExistsError)) throw error;
    // A concurrent upload under the same key won: answer its file, drop ours.
    await deleteFile(BUCKET, `${organizationId}/${file}`);
    const winner = await readPointer(pointer);
    if (!winner) throw error;
    return { url: urlOf(winner) };
  }
}
