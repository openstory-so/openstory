/**
 * Storage Cloudflare — Native R2 binding implementation.
 * Used on Cloudflare Workers via the workerd condition in package.json imports.
 *
 * Signed URLs are not supported by R2 bindings and lazy-import the S3 SDK.
 */

import { env as workerEnv } from 'cloudflare:workers';
import {
  buildR2Key,
  getPublicUrl,
  type MultipartPart,
  type StorageBucket,
  type StorageFileInfo,
  type UploadResult,
} from './buckets';

function getR2Bucket(): R2Bucket {
  // Reach for the binding via `cloudflare:workers` directly so the type
  // resolves to R2Bucket. `#env` resolves to a process.env shim at typecheck
  // time (because tsgo doesn't apply the `workerd` import condition), which
  // would type bindings as `string`.
  const bucket = workerEnv.R2_STORAGE_BUCKET;
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- generated Env types the bucket as always-present; guard against wrangler.jsonc drift
  if (!bucket) {
    throw new Error(
      'R2 binding "R2_STORAGE_BUCKET" not found. Ensure r2_buckets is configured in wrangler.jsonc'
    );
  }
  return bucket;
}

export async function uploadFile(
  bucket: StorageBucket,
  path: string,
  file: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  options?: {
    upsert?: boolean;
    contentType?: string;
    cacheControl?: string;
  }
): Promise<UploadResult> {
  const key = buildR2Key(bucket, path);

  try {
    const r2 = getR2Bucket();
    // R2 natively accepts all types in our union (ReadableStream, ArrayBuffer,
    // ArrayBufferView, Blob) — no conversion needed.
    await r2.put(key, file, {
      httpMetadata: {
        contentType: options?.contentType,
        cacheControl: options?.cacheControl ?? 'public, max-age=31536000',
      },
    });

    const publicUrl = getPublicUrl(bucket, path);

    return {
      path: key,
      publicUrl,
      fullPath: key,
    };
  } catch (error) {
    throw new Error(
      `Failed to upload file to ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Multipart uploads. Cloudflare Workers cap a single request body at ~100MB,
// so large uploads (e.g. exported MP4s) are split client-side into parts and
// streamed through the Worker via these helpers. Each helper is a distinct
// Worker invocation, so we hold no upload object across requests — we
// re-attach to the in-flight upload with `resumeMultipartUpload(key, uploadId)`
// each time.
// ───────────────────────────────────────────────────────────────────────────

export async function createMultipartUpload(
  bucket: StorageBucket,
  path: string,
  contentType?: string
): Promise<{ uploadId: string; key: string }> {
  const r2 = getR2Bucket();
  const key = buildR2Key(bucket, path);
  const upload = await r2.createMultipartUpload(key, {
    httpMetadata: {
      contentType,
      cacheControl: 'public, max-age=31536000',
    },
  });
  return { uploadId: upload.uploadId, key };
}

export async function uploadPart(
  bucket: StorageBucket,
  path: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | Blob
): Promise<MultipartPart> {
  const r2 = getR2Bucket();
  const key = buildR2Key(bucket, path);
  const upload = r2.resumeMultipartUpload(key, uploadId);
  const uploaded = await upload.uploadPart(partNumber, body);
  return { partNumber: uploaded.partNumber, etag: uploaded.etag };
}

export async function completeMultipartUpload(
  bucket: StorageBucket,
  path: string,
  uploadId: string,
  parts: MultipartPart[]
): Promise<UploadResult> {
  const r2 = getR2Bucket();
  const key = buildR2Key(bucket, path);
  const upload = r2.resumeMultipartUpload(key, uploadId);
  await upload.complete(parts);
  const publicUrl = getPublicUrl(bucket, path);
  return { path: key, publicUrl, fullPath: key };
}

export async function abortMultipartUpload(
  bucket: StorageBucket,
  path: string,
  uploadId: string
): Promise<void> {
  const r2 = getR2Bucket();
  const key = buildR2Key(bucket, path);
  const upload = r2.resumeMultipartUpload(key, uploadId);
  await upload.abort();
}

export async function getSignedUrl(
  bucket: StorageBucket,
  path: string,
  _expiresIn = 3600
): Promise<string> {
  // R2 files are publicly accessible via CDN — no signing needed on Cloudflare.
  // The S3 SDK fallback previously here pulled ~19MB of @aws-sdk into the Worker
  // bundle, contributing to OOM (error 1102) on the 128MB Workers memory limit.
  return getPublicUrl(bucket, path);
}

export async function getSignedUrlWithDownload(
  bucket: StorageBucket,
  path: string,
  _filename: string,
  _expiresIn = 3600
): Promise<string> {
  // R2 files are publicly accessible — return public URL.
  // Custom download filename (ResponseContentDisposition) is not supported
  // without S3 presigned URLs, but keeping the AWS SDK out of the Worker
  // bundle is worth the trade-off. Browser "Save As" still works.
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
  // R2 bindings don't support presigned URLs — proxy through the worker instead
  // Pass raw path — uploadFile will call buildR2Key itself
  const params = new URLSearchParams({ bucket, path, contentType });
  const uploadUrl = `/api/storage/upload?${params}`;
  const publicUrl = getPublicUrl(bucket, path);
  return { uploadUrl, publicUrl, path: buildR2Key(bucket, path), contentType };
}

export async function deleteFile(
  bucket: StorageBucket,
  path: string
): Promise<void> {
  const r2 = getR2Bucket();
  const key = buildR2Key(bucket, path);

  try {
    await r2.delete(key);
  } catch (error) {
    throw new Error(
      `Failed to delete file from ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteFiles(
  bucket: StorageBucket,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return;

  const r2 = getR2Bucket();

  try {
    const keys = paths.map((path) => buildR2Key(bucket, path));
    await r2.delete(keys);
  } catch (error) {
    throw new Error(
      `Failed to delete files from ${bucket}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function listFiles(
  bucket: StorageBucket,
  path = '',
  options?: {
    limit?: number;
    offset?: number;
    sortBy?: { column: string; order: 'asc' | 'desc' };
  }
): Promise<StorageFileInfo[]> {
  const r2 = getR2Bucket();
  const prefix = buildR2Key(bucket, path);

  try {
    const listed = await r2.list({
      prefix,
      limit: options?.limit,
      include: ['httpMetadata'],
    });

    return listed.objects.map((obj) => ({
      name: obj.key.replace(`${prefix}/`, ''),
      id: obj.key,
      updated_at: obj.uploaded.toISOString(),
      created_at: obj.uploaded.toISOString(),
      last_accessed_at: obj.uploaded.toISOString(),
      metadata: {
        size: obj.size,
        mimetype: obj.httpMetadata?.contentType ?? '',
        cacheControl: obj.httpMetadata?.cacheControl ?? '',
        eTag: obj.httpEtag,
      },
    }));
  } catch (error) {
    throw new Error(
      `Failed to list files in ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function moveFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  await copyFile(bucket, fromPath, toPath);
  await deleteFile(bucket, fromPath);
}

export async function copyFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  const r2 = getR2Bucket();
  const sourceKey = buildR2Key(bucket, fromPath);
  const destKey = buildR2Key(bucket, toPath);

  try {
    const source = await r2.get(sourceKey);
    if (!source) {
      throw new Error(`Source file not found: ${fromPath}`);
    }

    await r2.put(destKey, source.body, {
      httpMetadata: source.httpMetadata,
      customMetadata: source.customMetadata,
    });
  } catch (error) {
    throw new Error(
      `Failed to copy file from ${fromPath} to ${toPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * `false` means R2 answered "no such key". An R2 failure propagates: callers
 * turn a `false` into "re-upload it", which is the wrong instruction for a
 * transient error.
 */
export async function fileExists(
  bucket: StorageBucket,
  path: string
): Promise<boolean> {
  const r2 = getR2Bucket();
  const head = await r2.head(buildR2Key(bucket, path));
  return head !== null;
}

/**
 * Read a storage object's bytes straight from the R2 binding by key
 * (`<bucket>/<path>`). Used by server-side consumers of stored `/r2/<key>`
 * URLs that need the bytes rather than a URL (fal-storage shim uploads,
 * vision data-URIs, PNG header sniffing) — a relative URL can't be `fetch`ed
 * from inside the worker, and reading the binding avoids an HTTP round-trip.
 * Pass `range` to read a prefix (e.g. an image header) without downloading
 * the whole object.
 */
export async function readStorageObject(
  key: string,
  range?: { offset: number; length: number }
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string } | null> {
  const r2 = getR2Bucket();
  const object = await r2.get(key, range ? { range } : undefined);
  if (!object) return null;
  return {
    bytes: new Uint8Array(await object.arrayBuffer()),
    contentType: object.httpMetadata?.contentType ?? '',
  };
}

/**
 * Serve a storage object straight from the R2 binding. Backs the `/r2/$`
 * route (see src/routes/r2.$.ts), which streams stored media whenever no
 * public CDN domain is configured — local dev, e2e, and CDN-less production
 * deployments (deploy-button workers). With a CDN domain set the route
 * redirects instead and this is not called. Supports Range requests so
 * `<video>` seeking works.
 */
export async function serveFile(
  key: string,
  request: Request
): Promise<Response> {
  const r2 = getR2Bucket();
  // R2 accepts the request Headers directly and resolves the Range header
  // itself; the returned object's `range` reflects what was actually served.
  const hasRange = request.headers.has('range');
  const object = await r2.get(
    key,
    hasRange ? { range: request.headers } : undefined
  );
  if (!object) {
    return new Response('Not found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');

  // Only emit a 206 when the client actually sent a Range header — Miniflare
  // populates `object.range` even on full reads, and a 206 for a plain GET
  // confuses caches and some clients.
  const range = hasRange ? object.range : undefined;
  if (range) {
    const offset = 'offset' in range ? (range.offset ?? 0) : 0;
    const length =
      'suffix' in range
        ? range.suffix
        : (('length' in range ? range.length : undefined) ??
          object.size - offset);
    const start = 'suffix' in range ? object.size - range.suffix : offset;
    headers.set(
      'content-range',
      `bytes ${start}-${start + length - 1}/${object.size}`
    );
    return new Response(object.body, { status: 206, headers });
  }

  return new Response(object.body, { headers });
}
