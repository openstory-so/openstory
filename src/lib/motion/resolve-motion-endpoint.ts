/**
 * Resolve which fal endpoint a motion run submits to (#873).
 *
 * Most models have a single image-to-video endpoint (`modelConfig.id`). A few
 * accept cast/element reference images only on a SEPARATE reference-to-video
 * endpoint that takes `image_urls[]` bound to per-model prompt tokens and has
 * no single start-frame `image_url` — see `MOTION_REFERENCE_ENDPOINTS`. When a
 * scene actually has references AND the model has such an endpoint, route there;
 * otherwise stay on the normal image-to-video endpoint.
 *
 * `references` is how those images ride, if at all:
 *   - `endpoint` — dedicated reference-to-video endpoint (Seedance)
 *   - `inline` — same i2v endpoint, URLs on the request body (Kling `elements`)
 *   - `none` — URLs are not sent; tokens become descriptions in the prompt
 */

import {
  IMAGE_TO_VIDEO_MODELS,
  attachesInlineReferences,
  getMotionReferenceEndpoint,
  type ImageToVideoModel,
  type MotionReferenceEndpointConfig,
} from '@/lib/ai/models';
import type { MediaVia } from '@/lib/ai/via';

export type MotionEndpointResolution =
  | {
      /** Pricing Via — which API this endpoint is called on. Vendor is `model.vendor`. */
      via: MediaVia;
      endpointId: string;
      references: 'none' | 'inline';
    }
  | {
      via: MediaVia;
      endpointId: string;
      references: 'endpoint';
      /** Tag syntax + image cap for binding refs into the prompt. */
      referenceConfig: MotionReferenceEndpointConfig;
    };

export function resolveMotionEndpoint(
  modelKey: ImageToVideoModel,
  hasReferenceImages: boolean
): MotionEndpointResolution {
  if (hasReferenceImages) {
    const referenceConfig = getMotionReferenceEndpoint(modelKey);
    if (referenceConfig) {
      return {
        via: 'fal',
        endpointId: referenceConfig.endpointId,
        references: 'endpoint',
        referenceConfig,
      };
    }
    if (attachesInlineReferences(modelKey)) {
      return {
        via: 'fal',
        endpointId: IMAGE_TO_VIDEO_MODELS[modelKey].id,
        references: 'inline',
      };
    }
  }
  return {
    via: 'fal',
    endpointId: IMAGE_TO_VIDEO_MODELS[modelKey].id,
    references: 'none',
  };
}
