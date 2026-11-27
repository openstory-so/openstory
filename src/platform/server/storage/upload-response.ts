/**
 * Upload Response — streams a fetch Response body directly to R2/S3,
 * passing the ReadableStream to avoid buffering the entire file in memory.
 *
 * On Cloudflare Workers: R2 binding natively accepts ReadableStream.
 * On local dev (Bun): Bun's native S3 client handles streaming uploads.
 */

import type { StorageBucket, UploadResult } from './buckets';
import { uploadFile } from '#storage';

export async function uploadResponse(
  response: Response,
  bucket: StorageBucket,
  path: string,
  options?: {
    contentType?: string;
    cacheControl?: string;
    /** `false`: create-only, never replace an object. */
    upsert?: boolean;
  }
): Promise<UploadResult> {
  const body = response.body;
  if (!body) {
    throw new Error('Response body is null — cannot upload empty response');
  }

  // workerd's r2.put() rejects ReadableStreams without a known length.
  // fetch responses keep that link when Content-Length is set upstream,
  // but some sources (chunked transfer encoding, intermediate proxies)
  // strip it — and once it's gone, R2 throws "Provided readable stream
  // must have a known length...". Re-establish the length via
  // FixedLengthStream when the header is present, fall back to buffering
  // when it's not. See issue #738.
  //
  // `FixedLengthStream` only exists on workerd; on Bun the native S3
  // client streams responses without this restriction, so we leave the
  // body untouched there.
  if (typeof FixedLengthStream !== 'undefined') {
    const contentLengthHeader = response.headers.get('content-length');
    const contentLength = contentLengthHeader
      ? Number.parseInt(contentLengthHeader, 10)
      : Number.NaN;

    if (Number.isFinite(contentLength) && contentLength > 0) {
      const fixed = new FixedLengthStream(contentLength);
      body.pipeTo(fixed.writable).catch(() => {
        // Pipe errors propagate through the readable side and reject
        // r2.put() below, which the outer caller surfaces.
      });
      return uploadFile(bucket, path, fixed.readable, {
        ...options,
        upsert: options?.upsert ?? true,
      });
    }

    // No Content-Length: buffer to a bounded payload so r2.put() can
    // size it. All current callers upload bounded media (merged videos,
    // generated images, motion clips, music tracks), so this stays
    // within Worker memory limits.
    const buffer = await response.arrayBuffer();
    return uploadFile(bucket, path, buffer, {
      ...options,
      upsert: options?.upsert ?? true,
    });
  }

  return uploadFile(bucket, path, body, {
    ...options,
    upsert: options?.upsert ?? true,
  });
}
