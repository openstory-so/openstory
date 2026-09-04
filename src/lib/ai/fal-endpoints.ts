/**
 * Shared helper: collects all deduplicated fal.ai endpoint IDs from our model configs.
 */
import {
  AUDIO_MODELS,
  EDIT_ENDPOINTS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { studioVideoEndpointIds } from '@/lib/studio/text-to-video';

export function getFalEndpointIds(): string[] {
  const video = Object.values(IMAGE_TO_VIDEO_MODELS).map((m) => m.id);
  const image = Object.values(IMAGE_MODELS).map((m) => m.id);
  const audio = Object.values(AUDIO_MODELS).map((m) => m.id);
  const edit = Object.values(EDIT_ENDPOINTS);
  const motionRef = Object.values(MOTION_REFERENCE_ENDPOINTS).map(
    (m) => m.endpointId
  );
  const studioVideo = studioVideoEndpointIds();

  return [
    ...new Set([
      ...video,
      ...studioVideo,
      ...image,
      ...edit,
      ...audio,
      ...motionRef,
    ]),
  ];
}

/**
 * Priceable fal endpoints that appear in NO listing — not fal's active
 * catalog, not modelschemas — so the pricing refresh must name them
 * explicitly. Verified against the pricing API when added. Endpoints we use
 * in model configs don't belong here (`getFalEndpointIds` covers those), and
 * neither do aliases: fal canonicalizes e.g.
 * `enterprise/image-to-video` → `enterprise/v2/image-to-video` and omits the
 * alias from any response that also names the canonical id.
 */
export const UNLISTED_FAL_ENDPOINTS = [
  'bytedance/seedance-2.0/enterprise/text-to-video',
  'bytedance/seedance-2.0/enterprise/v2/video-to-video',
];
