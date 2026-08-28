/**
 * R2 uploads for Images and Videos assets (#1274).
 *
 * Keys live under `teams/<teamId>/studio/<assetId>/` so they never collide
 * with sequence frame paths. URLs are origin-relative `/r2/<key>` (#894).
 */

import { uploadImageFromUrl } from '@/lib/image/image-storage';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';

type StudioUploadResult = {
  url: string;
  path: string;
  contentType: string;
};

export function uploadStudioImage(params: {
  imageUrl: string;
  teamId: string;
  assetId: string;
}): Promise<StudioUploadResult> {
  return uploadImageFromUrl(
    params.imageUrl,
    (extension) =>
      `teams/${params.teamId}/studio/${params.assetId}/image.${extension}`
  );
}

export async function uploadStudioVideo(params: {
  videoUrl: string;
  teamId: string;
  assetId: string;
}): Promise<StudioUploadResult> {
  const response = await fetch(params.videoUrl);
  if (!response.ok) {
    throw new Error(`Failed to download video: ${response.status}`);
  }

  const headerType = response.headers.get('content-type');
  const urlExtension = getExtensionFromUrl(params.videoUrl);
  let extension = urlExtension;
  if (urlExtension === 'jpg' && headerType) {
    if (headerType.includes('mp4')) extension = 'mp4';
    else if (headerType.includes('webm')) extension = 'webm';
    else if (headerType.includes('quicktime') || headerType.includes('mov')) {
      extension = 'mov';
    } else extension = 'mp4';
  }
  // From the extension, not the CDN header: an `application/octet-stream`
  // response would otherwise make the gallery render the clip as an image.
  const contentType = getMimeTypeFromExtension(extension);
  const path = `teams/${params.teamId}/studio/${params.assetId}/video.${extension}`;

  const result = await uploadResponse(response, STORAGE_BUCKETS.VIDEOS, path, {
    contentType,
  });

  return { url: result.publicUrl, path, contentType };
}
