/**
 * Image Storage Service
 * Handles uploading and managing images in R2 Storage
 */

import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromMimeType,
  getExtensionFromUrl,
  getMimeTypeFromExtension,
  sniffImageMimeType,
} from '@/lib/utils/file';
import { generateId } from '@/lib/db/id';

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

/**
 * Download an image from a (provider) URL into the thumbnails bucket.
 * `buildPath` receives the resolved file extension so callers own the
 * key layout without duplicating the type sniffing below.
 */
export async function uploadImageFromUrl(
  imageUrl: string,
  buildPath: (extension: string) => string
): Promise<StorageResult> {
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
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
