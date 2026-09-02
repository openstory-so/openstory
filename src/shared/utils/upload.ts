/**
 * Client-side upload utilities.
 *
 * putToR2 uploads a blob to R2 through the Worker. It is size-aware:
 *   - Small payloads (≤ MULTIPART_THRESHOLD) → one streamed PUT to
 *     /api/storage/upload.
 *   - Large payloads → R2 multipart via /api/storage/multipart, because
 *     Cloudflare caps a single request body at ~100MB. The blob is sliced into
 *     equal parts (R2 requires equal non-final parts ≥5MiB), each uploaded in
 *     its own request, then completed server-side.
 *
 * XHR (not fetch) is used for the byte-carrying PUTs: fetch stalls large upload
 * bodies in Chrome, and XHR gives real upload progress.
 */

import type { MultipartPart } from '@/lib/storage/buckets';
import { z } from 'zod';

const createResponseSchema = z.object({ uploadId: z.string().min(1) });
const partResponseSchema = z.object({
  part: z.object({
    partNumber: z.number().int().positive(),
    etag: z.string().min(1),
  }),
});

export function getFileKey(file: File): string {
  return `${file.name}-${file.lastModified}`;
}

// Single-PUT below this; multipart at/above. Kept under Cloudflare's ~100MB
// request-body limit with headroom.
const MULTIPART_THRESHOLD = 90 * 1024 * 1024; // 90 MiB
// Equal non-final part size. R2 requires every non-final part to be the same
// size and ≥5MiB; each part request must also stay under the body limit.
const PART_SIZE = 50 * 1024 * 1024; // 50 MiB

type PutOptions = { signal?: AbortSignal; timeoutMs?: number };

export function putToR2(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onProgress?: (percent: number) => void,
  options?: PutOptions
): Promise<void> {
  if (file.size <= MULTIPART_THRESHOLD) {
    return putSingle(uploadUrl, file, contentType, onProgress, options);
  }
  return putMultipart(uploadUrl, file, contentType, onProgress, options);
}

async function putSingle(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onProgress?: (percent: number) => void,
  options?: PutOptions
): Promise<void> {
  await xhrPut(uploadUrl, file, contentType, {
    ...options,
    onLoaded: (loaded) =>
      onProgress?.(Math.round((loaded / Math.max(file.size, 1)) * 100)),
  });
}

async function putMultipart(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onProgress?: (percent: number) => void,
  options?: PutOptions
): Promise<void> {
  const { signal, timeoutMs } = options ?? {};

  // The single-upload URL encodes the destination as ?bucket&path — reuse it so
  // multipart targets the exact same object (and same team-scoping check).
  const parsed = new URL(uploadUrl, globalThis.location.origin);
  const bucket = parsed.searchParams.get('bucket');
  const path = parsed.searchParams.get('path');
  if (!bucket || !path) {
    throw new Error('putToR2: upload URL is missing bucket/path for multipart');
  }
  const base = `/api/storage/multipart?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;

  const createRes = await fetch(
    `${base}&action=create&contentType=${encodeURIComponent(contentType)}`,
    { method: 'POST', signal }
  );
  if (!createRes.ok) {
    throw new Error(`Multipart create failed: ${createRes.status}`);
  }
  const { uploadId } = createResponseSchema.parse(await createRes.json());

  const totalParts = Math.ceil(file.size / PART_SIZE);
  const parts: MultipartPart[] = [];
  let uploadedBytes = 0;

  try {
    for (let i = 0; i < totalParts; i++) {
      const start = i * PART_SIZE;
      const chunk = file.slice(start, Math.min(start + PART_SIZE, file.size));
      const partNumber = i + 1;
      const xhr = await xhrPut(
        `${base}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
        chunk,
        contentType,
        {
          signal,
          timeoutMs,
          onLoaded: (loaded) => {
            const percent = Math.round(
              ((uploadedBytes + loaded) / file.size) * 100
            );
            // Reserve 100% for after `complete` succeeds.
            onProgress?.(Math.min(99, percent));
          },
        }
      );
      const { part } = partResponseSchema.parse(JSON.parse(xhr.responseText));
      parts.push(part);
      uploadedBytes += chunk.size;
    }

    const completeRes = await fetch(
      `${base}&action=complete&uploadId=${encodeURIComponent(uploadId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts }),
        signal,
      }
    );
    if (!completeRes.ok) {
      throw new Error(`Multipart complete failed: ${completeRes.status}`);
    }
    onProgress?.(100);
  } catch (error) {
    // Best-effort cleanup so a failed upload doesn't leave orphaned parts.
    void fetch(
      `${base}&action=abort&uploadId=${encodeURIComponent(uploadId)}`,
      { method: 'POST' }
    ).catch(() => {});
    throw error;
  }
}

/**
 * Low-level streamed PUT via XHR. Resolves with the completed XHR (so callers
 * can read the response body), rejects on non-2xx / error / timeout / abort.
 */
function xhrPut(
  url: string,
  body: Blob,
  contentType: string,
  opts: PutOptions & { onLoaded?: (loadedBytes: number) => void }
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs, onLoaded } = opts;
    if (signal?.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onLoaded?.(event.loaded);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr);
      } else {
        reject(new Error(`R2 upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.ontimeout = () =>
      reject(new Error(`Upload timed out after ${timeoutMs}ms`));

    if (signal) {
      xhr.onabort = () =>
        reject(new DOMException('Upload aborted', 'AbortError'));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    if (timeoutMs !== undefined) xhr.timeout = timeoutMs;

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.send(body);
  });
}
