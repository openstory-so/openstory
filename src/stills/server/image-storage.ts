/**
 * Image Storage Service
 * Handles uploading and managing images in R2 Storage
 */

import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import {
  getExtensionFromMimeType,
  getExtensionFromUrl,
  getMimeTypeFromExtension,
  sniffImageMimeType,
} from '@/platform/server/storage/file';
import { generateId } from '@/platform/id';
import { fetchGeneratedImage } from '@/platform/server/storage/inline-image';

interface UploadImageOptions {
  imageUrl: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
}

interface UploadPosterOptions {
  imageUrl: string;
  teamId: string;
  sequenceId: string;
}

type StorageResult = {
  url: string;
  path: string;
  contentType: string;
};

/** Host for the error message; `new URL()` throws on our relative `/r2/` URLs. */
function imageSourceLabel(imageUrl: string): string {
  try {
    return new URL(imageUrl).host || imageUrl.slice(0, 40);
  } catch {
    return imageUrl.slice(0, 40);
  }
}

/**
 * Download an image from a (provider) URL into the thumbnails bucket.
 * `buildPath` receives the resolved file extension so callers own the
 * key layout without duplicating the type sniffing below.
 */
export async function uploadImageFromUrl(
  imageUrl: string,
  buildPath: (extension: string) => string
): Promise<StorageResult> {
  // Not a bare `fetch`: a generation can hand back inline `data:` bytes or a
  // stored `/r2/` URL we parked them at, and neither is fetchable (#1638).
  const response = await fetchGeneratedImage(imageUrl);

  if (!response.ok) {
    // `statusText` was the whole error we reported, and it is worthless:
    // provider CDNs send no reason phrase, so both occurrences to date read
    // `Failed to download image: <none>` — nothing to act on (#1435). The
    // status and the provider's error body are what name the cause.
    const body = (await response.text().catch(() => '')).slice(0, 200).trim();
    throw new Error(
      `Failed to download image from ${imageSourceLabel(imageUrl)}: ${response.status}${body ? ` ${body}` : ''}`
    );
  }

  // Magic bytes first: fal's upscale endpoints return extension-less URLs
  // (so `getExtensionFromUrl` defaults to `jpg`) and sometimes a Content-Type
  // that doesn't match the body. Storing PNG as `image/jpeg` makes Anthropic
  // reject the vision part — 400 today, historically an empty completion after
  // a billed reasoning pass (#1218). Header, then URL extension, only as
  // fallback when the body isn't a recognised image.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sniffed = sniffImageMimeType(bytes);
  const headerType = response.headers.get('content-type');
  const extension =
    getExtensionFromMimeType(sniffed) ??
    getExtensionFromMimeType(headerType) ??
    getExtensionFromUrl(imageUrl);
  const contentType = sniffed ?? getMimeTypeFromExtension(extension);

  const storagePath = buildPath(extension);

  const result = await uploadResponse(
    new Response(bytes, {
      headers: {
        'content-type': contentType,
        'content-length': String(bytes.byteLength),
      },
    }),
    STORAGE_BUCKETS.THUMBNAILS,
    storagePath,
    {
      contentType,
    }
  );

  return {
    url: result.publicUrl,
    path: storagePath,
    contentType,
  };
}

/**
 * Upload an image from URL to R2 Storage
 * Uses ULID-based filename and preserves original file extension
 */
export async function uploadImageToStorage(
  options: UploadImageOptions
): Promise<StorageResult> {
  const { imageUrl, teamId, sequenceId, shotId } = options;

  return uploadImageFromUrl(
    imageUrl,
    (extension) =>
      `teams/${teamId}/sequences/${sequenceId}/frames/${shotId}/${generateId()}.${extension}`
  );
}

/**
 * Upload a generated sequence poster to R2 Storage (#1117).
 *
 * Posters used to be persisted as the provider's own CDN URL, which expires —
 * the video-player empty state then silently 404s. Like every other generated
 * asset, the poster now lives in our bucket and the row holds the
 * origin-relative `/r2/` path (#894).
 */
export async function uploadPosterToStorage(
  options: UploadPosterOptions
): Promise<StorageResult> {
  const { imageUrl, teamId, sequenceId } = options;

  return uploadImageFromUrl(
    imageUrl,
    (extension) =>
      `teams/${teamId}/sequences/${sequenceId}/poster/${generateId()}.${extension}`
  );
}
