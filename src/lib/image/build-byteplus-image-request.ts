/**
 * Pure assembly of the exact BytePlus Ark request for an image generation
 * (#1157) — the Ark analogue of `build-image-request.ts`.
 *
 * Three shape differences from fal drive this file:
 *   - **No edit endpoint.** Ark carries reference images inline on the same
 *     `/images/generations` call, so `EDIT_ENDPOINTS` has no counterpart here
 *     and reference order is the only binding (the same order the fal route
 *     puts them in `image_urls[]`, so prompt tokens like `SCARLETT (Image 2)`
 *     resolve identically).
 *   - **`size` is a token or explicit pixels, never an aspect-ratio preset.**
 *     `2K` alone is square, so anything non-square has to be spelled in pixels.
 *   - **`watermark` defaults to TRUE.** Left implicit, Ark burns an
 *     "AI generated" mark into the bottom-right corner of every render.
 *
 * Client-safe: no env, no adapters.
 */

import { getBytePlusImageModelId, IMAGE_MODELS } from '@/lib/ai/models';
import {
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import type {
  BytePlusImageModel,
  BytePlusImageSize,
} from '@tanstack/ai-byteplus';

/**
 * Pixel dimensions per aspect preset, per resolution tier (#1449).
 *
 * Spelled out rather than sent as the `1K`/`2K` token because the token is
 * square: a 16:9 shot asked for as `2K` comes back 2048x2048 and gets
 * letterboxed downstream. 2K 16:9 lands at exactly 2.36 megapixels, which is
 * also Seedream's price-tier boundary — see the rate card in
 * `byteplus-pricing.ts`.
 *
 * Pro serves 1K and 2K only (no 4K token, unlike lite), so a 4K ask lands on
 * the 2K row rather than a size Ark rejects.
 */
const BYTEPLUS_IMAGE_DIMENSIONS: Record<
  '1K' | '2K',
  Record<ImageSize, BytePlusImageSize>
> = {
  '1K': {
    square_hd: '1024x1024',
    portrait_16_9: '576x1024',
    landscape_16_9: '1024x576',
  },
  '2K': {
    square_hd: '2048x2048',
    portrait_16_9: '1152x2048',
    landscape_16_9: '2048x1152',
  },
};

/** One entry of the Ark prompt-parts array. */
type BytePlusImagePromptPart =
  | { type: 'text'; content: string }
  | { type: 'image'; source: { type: 'url'; value: string } };

export type BytePlusImageRequest = {
  /** BytePlus Ark model id (not a fal endpoint). */
  modelId: BytePlusImageModel;
  prompt: BytePlusImagePromptPart[];
  /** `1K`/`2K`/`4K` token or explicit `WxH` pixels. */
  size: BytePlusImageSize;
  /** Unused on Pro — sequential/group generation is rejected. */
  numberOfImages?: number;
  modelOptions: Record<string, unknown>;
};

/**
 * Build the Ark request for an image generation.
 *
 * @throws Error when the model has no BytePlus via — callers claim the via
 * first (`isNativeBytePlusImageModel` + `claimBytePlusVia`), so reaching
 * here without one is a bug rather than a silent fallback.
 */
export function buildBytePlusImageRequest(
  params: ImageGenerationParams
): BytePlusImageRequest {
  const modelId = getBytePlusImageModelId(params.model);
  if (!modelId) {
    throw new Error(`No BytePlus model id for image model "${params.model}"`);
  }

  const maxPromptLength = IMAGE_MODELS[params.model].maxPromptLength;
  const prompt =
    params.prompt.length <= maxPromptLength
      ? params.prompt
      : `${params.prompt.slice(0, maxPromptLength - 3)}...`;

  // Pro serves 1K and 2K only, so 1080p and 4K both land on 2K.
  const tier = params.resolution === '720p' ? '1K' : '2K';
  const size =
    BYTEPLUS_IMAGE_DIMENSIONS[tier][params.imageSize ?? DEFAULT_IMAGE_SIZE];

  return {
    modelId,
    prompt: [
      { type: 'text', content: prompt },
      ...(params.referenceImageUrls ?? []).map(
        (url): BytePlusImagePromptPart => ({
          type: 'image',
          source: { type: 'url', value: url },
        })
      ),
    ],
    size,
    // Seedream 5.0 Pro rejects sequential/group generation
    // (`numberOfImages` / `sequential_image_generation`). One image per call.
    modelOptions: {
      watermark: false,
      ...(params.seed !== undefined && { seed: params.seed }),
    },
  };
}
