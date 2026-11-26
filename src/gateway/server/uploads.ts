/** `POST /api/v1/gateway/uploads`: a self-hosted install's input file, stored under the caller and checked for a real person (#2438). */

import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { outputExtension } from '@/gateway/server/storage';
import { withPlatformLlmKey } from '@/gateway/server/platform-credentials';
import { readIdempotencyKey } from '@/gateway/server/submit-job';
import { sha256Hex } from '@/platform/compliance/hash';
import { InsufficientCreditsError, ValidationError } from '@/platform/errors';
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
import {
  deleteFile,
  listFilesPage,
  readStorageObject,
  uploadFile,
} from '#storage';
import { estimateLLMCost } from '@/billing/cost-estimation';
import { assertGatewayRate } from '@/gateway/server/rate-limit';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';

const MB = 1024 * 1024;
/** The largest file per kind, enforced on the declared length and on the bytes read. */
const MAX_BYTES = { image: 20 * MB, video: 100 * MB, audio: 25 * MB } as const;
const MEDIA_TYPE = /^(image|video|audio)\//;
/** What one organization may keep here at once. */
const MAX_STORED_FILES = 500;
const MAX_STORED_BYTES = 2048 * MB;

const BUCKET = STORAGE_BUCKETS.GATEWAY_UPLOADS;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The body, failing once it carries more bytes than it declared; `over()` says whether it did. */
function capped(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): { stream: ReadableStream<Uint8Array> | null; over: () => boolean } {
  let seen = 0;
  const over = () => seen > limit;
  if (!body) return { stream: null, over };
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) {
          controller.error(new Error('Upload over its Content-Length'));
          return;
        }
        controller.enqueue(chunk);
      },
    })
  );
  return { stream, over };
}

/** One list page: more files than fit in it, or too many bytes, is refused. */
async function requireStorageRoom(organizationId: string, adding: number) {
  const { files, nextCursor } = await listFilesPage(BUCKET, organizationId, {
    limit: 1000,
  });
  const stored = files.filter((f) => !f.name.startsWith('keys/'));
  const bytes = stored.reduce((sum, f) => sum + f.size, 0);
  if (
    nextCursor !== null ||
    stored.length >= MAX_STORED_FILES ||
    bytes + adding > MAX_STORED_BYTES
  ) {
    throw new ValidationError(
      `This organization keeps at most ${MAX_STORED_FILES} gateway uploads (${MAX_STORED_BYTES / MB} MB)`
    );
  }
}

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
  const kind = contentType.split('/', 1)[0];
  const cap =
    kind === 'image' || kind === 'video' || kind === 'audio'
      ? MAX_BYTES[kind]
      : 0;
  const length = Number(request.headers.get('content-length'));
  if (!(Number.isInteger(length) && length > 0 && length <= cap)) {
    throw new ValidationError(
      `Content-Length is required and at most ${cap / MB} MB for ${kind}`
    );
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

  // Before any byte is read: the account and the rate; a new file also the check's price and the stored total.
  await requireGenerationAllowed({ userId: scopedDb.userId, organizationId });
  await assertGatewayRate(organizationId, 'uploads');

  const pointer = await pointerPath(organizationId, key);
  const existing = await readPointer(pointer);
  if (existing) {
    void request.body?.cancel();
    const url = urlOf(existing);
    // The pointer is written only after a pass; this answers from the stored verdict.
    await check(url);
    return { url };
  }

  // The check is charged to this organization (`likeness:<url>`); refuse it before storing what it cannot pay for.
  if (!(await scopedDb.billing.hasEnoughCredits(estimateLLMCost(1)))) {
    throw new InsufficientCreditsError(
      'Insufficient credits to check an upload'
    );
  }
  await requireStorageRoom(organizationId, length);
  const file = `${generateId()}.${extension}`;
  const body = capped(request.body, length);
  try {
    await uploadResponse(
      new Response(body.stream, {
        headers: { 'content-length': String(length) },
      }),
      BUCKET,
      `${organizationId}/${file}`,
      { contentType, upsert: false }
    );
  } catch (error) {
    if (!body.over()) throw error;
    await deleteFile(BUCKET, `${organizationId}/${file}`);
    throw new ValidationError('The body is longer than its Content-Length');
  }
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
