/**
 * Storage — Node/Bun filesystem implementation.
 *
 * The local single-tenant server (npx/bunx) has no R2. Stored media lives under
 * a local directory (`OPENSTORY_STORAGE_DIR`, default `./.openstory/storage`),
 * keyed exactly as R2 is — `<bucket>/<path>` — so persisted URLs stay the
 * canonical origin-relative `/r2/<bucket>/<path>` form (#894) and the `/r2/$`
 * route serves them through `serveFile` with Range support, just like Workerd.
 *
 * Signatures mirror `storage-cloudflare.ts` exactly; this module is selected in
 * place of it only in the non-Workerd local build (see the `#storage` seam).
 */

import { createReadStream, type ReadStream } from 'node:fs';
import {
  copyFile as fsCopyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import {
  buildR2Key,
  getPublicUrl,
  type MultipartPart,
  type StorageBucket,
  type StorageFileInfo,
  type UploadResult,
} from './buckets';

function storageRoot(): string {
  return resolve(
    process.env.OPENSTORY_STORAGE_DIR ??
      join(process.cwd(), '.openstory/storage')
  );
}

/** Absolute on-disk path for an R2 key (`<bucket>/<path>`), root-jailed. */
function absPath(key: string): string {
  const root = storageRoot();
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + '/')) {
    throw new Error(`[storage-node] path escapes storage root: ${key}`);
  }
  return full;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function contentTypeFor(key: string): string {
  return (
    CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream'
  );
}

async function toBuffer(
  file: File | Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>
): Promise<Buffer> {
  if (Buffer.isBuffer(file)) return file;
  if (file instanceof Uint8Array) return Buffer.from(file);
  if (ArrayBuffer.isView(file)) {
    return Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  }
  if (file instanceof ArrayBuffer) return Buffer.from(new Uint8Array(file));
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    return Buffer.from(await file.arrayBuffer());
  }
  if (file instanceof ReadableStream) {
    const chunks: Buffer[] = [];
    const reader = file.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('[storage-node] unsupported upload body type');
}

async function writeKey(key: string, buffer: Buffer): Promise<void> {
  const path = absPath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
}

export async function uploadFile(
  bucket: StorageBucket,
  path: string,
  file: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  _options?: { upsert?: boolean; contentType?: string; cacheControl?: string }
): Promise<UploadResult> {
  const key = buildR2Key(bucket, path);
  await writeKey(key, await toBuffer(file));
  return { path: key, publicUrl: getPublicUrl(bucket, path), fullPath: key };
}

// ── Multipart: parts are staged under `.multipart/<uploadId>/<n>` and stitched
// in part-number order on complete. There is no size cap locally, so this only
// exists to satisfy the same interface the browser uploader drives through. ──

function multipartDir(uploadId: string): string {
  return absPath(join('.multipart', uploadId));
}

export async function createMultipartUpload(
  bucket: StorageBucket,
  path: string,
  _contentType?: string
): Promise<{ uploadId: string; key: string }> {
  const key = buildR2Key(bucket, path);
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await mkdir(multipartDir(uploadId), { recursive: true });
  // Stash the destination key so complete/abort need only the uploadId.
  await writeFile(join(multipartDir(uploadId), 'key'), key);
  return { uploadId, key };
}

export async function uploadPart(
  _bucket: StorageBucket,
  _path: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | Blob
): Promise<MultipartPart> {
  const buffer = await toBuffer(body);
  await writeFile(join(multipartDir(uploadId), String(partNumber)), buffer);
  return { partNumber, etag: `${partNumber}` };
}

export async function completeMultipartUpload(
  bucket: StorageBucket,
  path: string,
  uploadId: string,
  parts: MultipartPart[]
): Promise<UploadResult> {
  const dir = multipartDir(uploadId);
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const buffers: Buffer[] = [];
  for (const part of ordered) {
    buffers.push(await readFile(join(dir, String(part.partNumber))));
  }
  const key = buildR2Key(bucket, path);
  await writeKey(key, Buffer.concat(buffers));
  await rm(dir, { recursive: true, force: true });
  return { path: key, publicUrl: getPublicUrl(bucket, path), fullPath: key };
}

export async function abortMultipartUpload(
  _bucket: StorageBucket,
  _path: string,
  uploadId: string
): Promise<void> {
  await rm(multipartDir(uploadId), { recursive: true, force: true });
}

// ── Signed URLs: there is nothing to sign locally. Reads are public through
// the `/r2/$` route; writes proxy through `/api/storage/upload` exactly as the
// Workerd path does (R2 bindings can't presign either). ──

export async function getSignedUrl(
  bucket: StorageBucket,
  path: string,
  _expiresIn = 3600
): Promise<string> {
  return getPublicUrl(bucket, path);
}

export async function getSignedUrlWithDownload(
  bucket: StorageBucket,
  path: string,
  _filename: string,
  _expiresIn = 3600
): Promise<string> {
  return getPublicUrl(bucket, path);
}

export async function getSignedUploadUrl(
  bucket: StorageBucket,
  path: string,
  contentType: string,
  _expiresIn = 600
): Promise<{
  uploadUrl: string;
  publicUrl: string;
  path: string;
  contentType: string;
}> {
  const params = new URLSearchParams({ bucket, path, contentType });
  return {
    uploadUrl: `/api/storage/upload?${params}`,
    publicUrl: getPublicUrl(bucket, path),
    path: buildR2Key(bucket, path),
    contentType,
  };
}

export async function deleteFile(
  bucket: StorageBucket,
  path: string
): Promise<void> {
  await rm(absPath(buildR2Key(bucket, path)), { force: true });
}

export async function deleteFiles(
  bucket: StorageBucket,
  paths: string[]
): Promise<void> {
  await Promise.all(paths.map((path) => deleteFile(bucket, path)));
}

export async function listFiles(
  bucket: StorageBucket,
  path = '',
  options?: { limit?: number; offset?: number }
): Promise<StorageFileInfo[]> {
  const prefix = buildR2Key(bucket, path);
  const dir = absPath(prefix);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const rows: StorageFileInfo[] = [];
  for (const name of entries) {
    const info = await stat(join(dir, name));
    if (!info.isFile()) continue;
    const iso = info.mtime.toISOString();
    rows.push({
      name,
      id: `${prefix}/${name}`,
      updated_at: iso,
      created_at: info.birthtime.toISOString(),
      last_accessed_at: info.atime.toISOString(),
      metadata: {
        size: info.size,
        mimetype: contentTypeFor(name),
        cacheControl: 'public, max-age=31536000',
        eTag: `${info.size}-${info.mtimeMs}`,
      },
    });
  }
  const start = options?.offset ?? 0;
  return options?.limit
    ? rows.slice(start, start + options.limit)
    : rows.slice(start);
}

export async function moveFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  const from = absPath(buildR2Key(bucket, fromPath));
  const to = absPath(buildR2Key(bucket, toPath));
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

export async function copyFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  const from = absPath(buildR2Key(bucket, fromPath));
  const to = absPath(buildR2Key(bucket, toPath));
  await mkdir(dirname(to), { recursive: true });
  await fsCopyFile(from, to);
}

export async function fileExists(
  bucket: StorageBucket,
  path: string
): Promise<boolean> {
  try {
    await stat(absPath(buildR2Key(bucket, path)));
    return true;
  } catch {
    return false;
  }
}

export async function readStorageObject(
  key: string,
  range?: { offset: number; length: number }
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
  try {
    const buffer = await readFile(absPath(key));
    const sliced = range
      ? buffer.subarray(range.offset, range.offset + range.length)
      : buffer;
    // Copy into a standalone ArrayBuffer so the returned view owns its bytes.
    const bytes = new Uint8Array(sliced.byteLength);
    bytes.set(sliced);
    return { bytes, contentType: contentTypeFor(key) };
  } catch {
    return null;
  }
}

/**
 * Adapt a Node fs read stream to a global (web) `ReadableStream<Uint8Array>` —
 * the body type `Response` accepts. `Readable.toWeb` returns `@types/node`'s
 * `stream/web` ReadableStream, structurally incompatible with the DOM
 * `ReadableStream` the global `Response` expects, so wrap it by hand (keeping
 * basic backpressure via pause/resume).
 */
function nodeStreamToWeb(nodeStream: ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) nodeStream.pause();
      });
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    pull() {
      nodeStream.resume();
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export async function serveFile(
  key: string,
  request: Request
): Promise<Response> {
  const path = absPath(key);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }

  const contentType = contentTypeFor(key);
  const rangeHeader = request.headers.get('range');
  const baseHeaders: Record<string, string> = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000',
  };

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];
      let start = startRaw ? Number(startRaw) : 0;
      let end = endRaw ? Number(endRaw) : size - 1;
      if (!startRaw && endRaw) {
        // suffix range: bytes=-N → last N bytes
        start = Math.max(0, size - Number(endRaw));
        end = size - 1;
      }
      if (start > end || start >= size) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'content-range': `bytes */${size}` },
        });
      }
      end = Math.min(end, size - 1);
      const stream = nodeStreamToWeb(createReadStream(path, { start, end }));
      return new Response(stream, {
        status: 206,
        headers: {
          ...baseHeaders,
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': String(end - start + 1),
        },
      });
    }
  }

  const stream = nodeStreamToWeb(createReadStream(path));
  return new Response(stream, {
    headers: { ...baseHeaders, 'content-length': String(size) },
  });
}
