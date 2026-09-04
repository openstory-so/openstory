/**
 * Client-safe motion catalog: duration grids and resolution tokens baked
 * from the fal JSON schemas so the scene editor does not ship
 * `schemas.gen.ts` / `zod.gen.ts`.
 *
 * Keep in lockstep with the generated schemas — `model-capabilities.test.ts`
 * fails if `bun motion:codegen` changes a grid the UI still reads.
 */

import type { ImageToVideoModel } from '@/models/models';
import type { AspectRatio } from '@/models/aspect-ratios';
import { tiersForTokens, type Resolution } from '@/models/resolutions';

/** Allowed clip lengths in seconds, sorted. Empty = duration is not a field. */
export const MOTION_DURATION_GRID = {
  grok_imagine_video_1_5: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  ltx_2_3_pro: [6, 8, 10],
  veo3_1: [4, 6, 8],
  gemini_omni_flash: [3, 4, 5, 6, 7, 8, 9, 10],
  kling_v3_pro: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  minimax_hailuo_02: [],
  minimax_h3_max: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  seedance_v2: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  seedance_v2_mini: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  seedance_v2_5: [
    4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    24, 25, 26, 27, 28, 29, 30,
  ],
} as const satisfies Record<ImageToVideoModel, readonly number[]>;

/** `resolution` enum on the model's image-to-video endpoint. Empty = fixed size. */
export const MOTION_RESOLUTION_TOKENS = {
  grok_imagine_video_1_5: ['480p', '720p', '1080p'],
  ltx_2_3_pro: ['1080p', '1440p', '2160p'],
  veo3_1: ['720p', '1080p', '4k'],
  gemini_omni_flash: ['360p', '720p', '1080p', '4k'],
  kling_v3_pro: [],
  minimax_hailuo_02: [],
  // fal added 1080P (latent refinement from a native 768P source) upstream;
  // picked up by `bun motion:codegen`, unrelated to #1498.
  minimax_h3_max: ['480P', '768P', '1080P'],
  seedance_v2: ['480p', '720p', '1080p', '4k'],
  seedance_v2_mini: ['480p', '720p'],
  seedance_v2_5: ['480p', '720p', '1080p'],
} as const satisfies Record<ImageToVideoModel, readonly string[]>;

export function durationGridForModel(modelKey: ImageToVideoModel): number[] {
  return [...MOTION_DURATION_GRID[modelKey]];
}

export function motionResolutionTokensForModel(
  modelKey: ImageToVideoModel
): string[] {
  return [...MOTION_RESOLUTION_TOKENS[modelKey]];
}

/** Tiers a motion model can deliver — what the resolution picker offers. */
export function motionResolutionTiers(model: ImageToVideoModel): Resolution[] {
  return tiersForTokens(MOTION_RESOLUTION_TOKENS[model], 'video');
}

/** App aspect ratios this model's i2v endpoint accepts. */
export const MOTION_ASPECT_RATIOS = {
  grok_imagine_video_1_5: ['16:9', '9:16', '1:1'],
  ltx_2_3_pro: ['16:9', '9:16'],
  veo3_1: ['16:9', '9:16'],
  gemini_omni_flash: ['16:9', '9:16'],
  kling_v3_pro: ['16:9', '9:16', '1:1'],
  minimax_hailuo_02: ['16:9', '9:16', '1:1'],
  minimax_h3_max: ['16:9', '9:16', '1:1'],
  seedance_v2: ['16:9', '9:16', '1:1'],
  seedance_v2_mini: ['16:9', '9:16', '1:1'],
  seedance_v2_5: ['16:9', '9:16', '1:1'],
} as const satisfies Record<ImageToVideoModel, readonly AspectRatio[]>;

export function modelSupportsAspectRatio(
  model: ImageToVideoModel,
  aspectRatio: AspectRatio
): boolean {
  return MOTION_ASPECT_RATIOS[model].some((ratio) => ratio === aspectRatio);
}
