/**
 * Resolve which fal endpoint a motion run submits to (#873).
 *
 * Most models have a single image-to-video endpoint (`modelConfig.id`). A few
 * accept cast/element reference images only on a SEPARATE reference-to-video
 * endpoint that takes an image list bound to per-model prompt tokens and has
 * no single start-frame `image_url` — see `MOTION_REFERENCE_ENDPOINTS`. When a
 * scene actually has references AND the model has such an endpoint, route there;
 * otherwise stay on the normal image-to-video endpoint.
 *
 * `references` is how those images ride, if at all:
 *   - `endpoint` — dedicated reference-to-video endpoint (Seedance, H3 Max)
 *   - `inline` — URLs on the same generations call (Kling `elements`, Grok
 *     Imagine 1.5 native `reference`/`character` prompt parts)
 *   - `none` — URLs are not sent; tokens become descriptions in the prompt
 */

import { NATIVE_GROK_VIDEO_MODEL } from '@/lib/ai/grok-native';
import {
  IMAGE_TO_VIDEO_MODELS,
  attachesInlineReferences,
  getBytePlusVideoModelId,
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
  hasReferenceImages: boolean,
  via: MediaVia = 'fal'
): MotionEndpointResolution {
  if (via === 'xai') {
    // Imagine 1.5 reference-to-video rides the same `/videos/generations`
    // endpoint as image-to-video: extra images go on the generateVideo prompt
    // as `metadata.role: 'reference' | 'character'` parts. xAI forbids mixing
    // a start frame with `reference_images`, so submit drops start_frame and
    // sends the still as the first reference when this is `'inline'`.
    return {
      via: 'xai',
      endpointId: NATIVE_GROK_VIDEO_MODEL,
      references: hasReferenceImages ? 'inline' : 'none',
    };
  }
  if (via === 'byteplus') {
    // Ark Seedance is one model id for i2v and r2v. Refs ride as
    // `metadata.role: 'reference'` prompt parts — same mix-ban as Grok, so
    // the still becomes the first reference when this is `'inline'`.
    const endpointId = getBytePlusVideoModelId(modelKey);
    if (!endpointId) {
      throw new Error(`No BytePlus model id for motion model "${modelKey}"`);
    }
    return {
      via: 'byteplus',
      endpointId,
      references: hasReferenceImages ? 'inline' : 'none',
    };
  }
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
