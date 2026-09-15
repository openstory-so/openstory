/**
 * Image Storage Service
 * Handles uploading and managing images in R2 Storage
 */

import {
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import {
  getExtensionFromMimeType,
  getExtensionFromUrl,
  getMimeTypeFromExtension,
  sniffImageMimeType,
} from '@/platform/server/storage/file';
import { generateId } from '@/platform/id';

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

const DATA_URI = /^data:([^;,]+);base64,(.*)$/;

/**
 * Open a generated image for upload. Native Gemini always answers with
 * inline base64, and BytePlus can — workerd's `fetch` does not read `data:`.
 */
function fetchGeneratedImage(url: string): Promise<Response> {
  if (!url.startsWith('data:')) return fetch(url);
  const match = DATA_URI.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(
      'Malformed image data URI; expected data:<mime>;base64,<payload>'
    );
  }
  const bytes = Buffer.from(match[2], 'base64');
  const contentType = sniffImageMimeType(bytes) ?? match[1];
  return Promise.resolve(
    new Response(bytes, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
      },
    })
  );
}

/**
 * Persist a generated still to a known key. Runs inside the generating
 * `step.do` so inline bytes never reach a 1 MiB checkpoint (#1638, #1645).
 */
export async function storeGeneratedPng(
  imageUrl: string | undefined,
  bucket: StorageBucket,
  path: string
): Promise<{ url: string; path: string }> {
  if (!imageUrl) {
    throw new Error('No image URL returned from generation');
  }
  const response = await fetchGeneratedImage(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch generated image: ${response.status}`);
  }
  const uploaded = await uploadResponse(response, bucket, path, {
    contentType: 'image/png',
  });
  return { url: uploaded.publicUrl, path: uploaded.path };
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
  const response = await fetchGeneratedImage(imageUrl);

  if (!response.ok) {
    // `statusText` was the whole error we reported, and it is worthless:
    // provider CDNs send no reason phrase, so both occurrences to date read
    // `Failed to download image: <none>` — nothing to act on (#1435). The
    // status and the provider's error body are what name the cause.
    const body = (await response.text().catch(() => '')).slice(0, 200).trim();
    throw new Error(
      `Failed to download image: ${response.status}${body ? ` ${body}` : ''}`
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
