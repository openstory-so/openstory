/** R2 keys for gateway outputs: `teams/<organizationId>/gateway/<jobId>/`. */

import { organizationKeyPrefix } from '@/platform/server/storage/buckets';
import { uploadImageFromUrl } from '@/stills/server/image-storage';
import {
  uploadVideoFromUrl,
  type UploadedVideo,
} from '@/motion/server/video-storage';

export function uploadGatewayImage(params: {
  imageUrl: string;
  organizationId: string;
  jobId: string;
}): Promise<{ url: string; path: string; contentType: string }> {
  return uploadImageFromUrl(
    params.imageUrl,
    (extension) =>
      `${organizationKeyPrefix(params.organizationId)}/gateway/${params.jobId}/image.${extension}`
  );
}

export function uploadGatewayVideo(params: {
  videoUrl: string;
  organizationId: string;
  jobId: string;
  googleApiKey?: string;
}): Promise<UploadedVideo> {
  return uploadVideoFromUrl(
    params.videoUrl,
    (extension) =>
      `${organizationKeyPrefix(params.organizationId)}/gateway/${params.jobId}/video.${extension}`,
    { googleApiKey: params.googleApiKey }
  );
}
