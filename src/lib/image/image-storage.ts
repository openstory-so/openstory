/**
 * Image Storage Service
 * Handles uploading and managing images in R2 Storage
 */

import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadFile } from '#storage';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
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
};

/**
 * Download an image from a (provider) URL and stream it into the thumbnails
 * bucket. `buildPath` receives the resolved file extension so callers own the
 * key layout without duplicating the extension sniffing below.
 */
async function uploadImageFromUrl(
  imageUrl: string,
  buildPath: (extension: string) => string
): Promise<StorageResult> {
  if (imageUrl.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/.exec(imageUrl);
    if (!match?.[1] || !match[2]) {
      throw new Error('Invalid data URL for image upload');
    }
    const contentType = match[1];
    const extension = contentType.includes('png')
      ? 'png'
      : contentType.includes('webp')
        ? 'webp'
        : contentType.includes('jpeg') || contentType.includes('jpg')
          ? 'jpg'
          : 'png';
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const storagePath = buildPath(extension);
    const result = await uploadFile(
      STORAGE_BUCKETS.THUMBNAILS,
      storagePath,
      bytes,
      { contentType, upsert: true }
    );
    return { url: result.publicUrl, path: storagePath };
  }

  // Download image from URL first to get content type
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.statusText}`);
  }

  // Extract extension from URL or use response content-type
  const urlExtension = getExtensionFromUrl(imageUrl);
  const responseContentType = response.headers.get('content-type');

  // Prefer URL extension, fallback to content-type detection
  let extension = urlExtension;
  if (urlExtension === 'jpg' && responseContentType) {
    // If we defaulted to jpg, check if content-type suggests otherwise
    if (responseContentType.includes('png')) extension = 'png';
    else if (responseContentType.includes('webp')) extension = 'webp';
    else if (responseContentType.includes('gif')) extension = 'gif';
  }

  const storagePath = buildPath(extension);

  // Get proper MIME type for the extension
  const contentType = getMimeTypeFromExtension(extension);

  // Stream directly to R2 Storage (avoids buffering entire image in memory)
  const result = await uploadResponse(
    response,
    STORAGE_BUCKETS.THUMBNAILS,
    storagePath,
    {
      contentType,
    }
  );

  return {
    url: result.publicUrl,
    path: storagePath,
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
