/**
 * R2 uploads for Images and Videos assets (#1274).
 *
 * Keys live under `teams/<teamId>/studio/<assetId>/` so they never collide
 * with sequence frame paths. Ingest is the same helpers sequences use:
 * {@link uploadImageFromUrl} / {@link uploadVideoFromUrl}.
 */

import { uploadImageFromUrl } from '@/lib/image/image-storage';
import {
  uploadVideoFromUrl,
  type UploadedVideo,
} from '@/lib/motion/video-storage';

export function uploadStudioImage(params: {
  imageUrl: string;
  teamId: string;
  assetId: string;
}): Promise<{ url: string; path: string; contentType: string }> {
  return uploadImageFromUrl(
    params.imageUrl,
    (extension) =>
      `teams/${params.teamId}/studio/${params.assetId}/image.${extension}`
  );
}

export function uploadStudioVideo(params: {
  videoUrl: string;
  teamId: string;
  assetId: string;
  googleApiKey?: string;
}): Promise<UploadedVideo> {
  return uploadVideoFromUrl(
    params.videoUrl,
    (extension) =>
      `teams/${params.teamId}/studio/${params.assetId}/video.${extension}`,
    { googleApiKey: params.googleApiKey }
  );
}
