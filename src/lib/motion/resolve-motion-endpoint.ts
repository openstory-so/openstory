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
 *
 * `referenceOnly` is the mode where no start frame was ever rendered: the clip
 * is driven by the cast/element/location sheets and a self-describing prompt.
 * It forces the reference route even when a shot happens to have matched no
 * references at all (a two-hander in an unmatched location still has to reach
 * an endpoint whose start frame is optional), and it is what tells the request
 * builders not to reserve `@Image1` for a still that does not exist.
 */

import { NATIVE_GEMINI_VIDEO_MODEL } from '@/lib/ai/gemini-native';
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
  via: MediaVia = 'fal',
  referenceOnly = false
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
      // Reference-only rides `inline` even with nothing matched: there is no
      // start frame to fall back to, so the request is prompt-plus-refs and
      // the builder must not look for a still to pin as `start_frame`.
      references: hasReferenceImages || referenceOnly ? 'inline' : 'none',
    };
  }
  if (via === 'google') {
    // Omni Flash serves every task from one Interactions model: images ride
    // the same generateVideo prompt as content blocks, bound in the prompt
    // text by `<IMAGE_REF_n>` tags. There is no start-frame field, so with
    // references the still goes first and the task is pinned to
    // reference_to_video (see buildGeminiVideoRequest).
    return {
      via: 'google',
      endpointId: NATIVE_GEMINI_VIDEO_MODEL,
      // Reference-only rides `inline` even with nothing matched, same as the
      // xAI and Ark cases: there is no start frame to fall back to, so the
      // builder must not reserve the first slot for a still.
      references: hasReferenceImages || referenceOnly ? 'inline' : 'none',
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
      references: hasReferenceImages || referenceOnly ? 'inline' : 'none',
    };
  }
  if (hasReferenceImages || referenceOnly) {
    const referenceConfig = getMotionReferenceEndpoint(modelKey);
    if (referenceConfig) {
      return {
        via: 'fal',
        endpointId: referenceConfig.endpointId,
        references: 'endpoint',
        referenceConfig,
      };
    }
    // Reference-only has nowhere to go on a model without a reference route:
    // every remaining fal endpoint requires `image_url`, and there is no still.
    // Fail here rather than submitting a request the endpoint must reject —
    // `createSequenceSchema` / `canRenderReferenceOnly` gate this at creation,
    // so reaching it means a model swap slipped past that gate.
    if (referenceOnly) {
      throw new Error(
        `Motion model "${modelKey}" has no reference-to-video endpoint and cannot render without a start frame`
      );
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
