/**
 * Wall-clock seconds from Production PostHog `posthog.metrics`
 * (`gen_ai.client.operation.duration`, 30 days ending 2026-09-01).
 *
 * `n` is completed generations. `p50` / `p90` are seconds. This is not a
 * governed catalog metric — re-query PostHog before changing the numbers.
 *
 * Rows with `proxy` have no (or too few) samples; they copy a sibling.
 */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';

export type WallClock = {
  p50: number;
  p90: number;
  n: number;
  /** Catalog key this row copies when `n` is 0. */
  proxy?: string;
};

/** Fal typically runs about this many motion jobs at once. */
export const FAL_MOTION_CONCURRENCY = 6;

/**
 * LLM prompt steps that run in parallel with sheets (phase 3) or after
 * stills (phase 4). From `$ai_generation` `$ai_latency`, same 30-day window.
 */
export const VISUAL_PROMPT_P90_SECONDS = 34;
export const MOTION_PROMPT_P90_SECONDS = 17;

/**
 * Script analysis (phase 1) is several sequential LLM calls. Quality
 * `base + perScene` is fit to the 11-scene 151s wall-clock plus p1 p90.
 * Fast is Opus 5 Fast split (~6s) plus a Luna/GLM-class enhance — Luna
 * itself has no samples yet.
 */
export const ANALYSIS_QUALITY = { base: 55, perScene: 9 };
export const ANALYSIS_FAST = { base: 40, perScene: 5 };
export const CASTING_QUALITY = { base: 12, perScene: 1 };
export const CASTING_FAST = { base: 8, perScene: 1 };

export const VIDEO_WALL_CLOCK = {
  grok_imagine_video_1_5: { p50: 33, p90: 44, n: 18 },
  ltx_2_3_pro: { p50: 126, p90: 199, n: 39 },
  veo3_1: { p50: 147, p90: 156, n: 6 },
  kling_v3_pro: { p50: 306, p90: 328, n: 3 },
  minimax_hailuo_02: { p50: 199, p90: 228, n: 14 },
  minimax_h3_max: { p50: 10, p90: 10, n: 74 },
  seedance_v2: { p50: 208, p90: 288, n: 611 },
  seedance_v2_5: { p50: 208, p90: 288, n: 0, proxy: 'seedance_v2' },
} as const satisfies Record<ImageToVideoModel, WallClock>;

export const IMAGE_WALL_CLOCK = {
  gpt_image_2: { p50: 99, p90: 126, n: 2659 },
  krea_2_turbo: { p50: 3, p90: 3, n: 1326 },
  flux_2_turbo: { p50: 3, p90: 8, n: 585 },
  nano_banana_2: { p50: 25, p90: 41, n: 209 },
  grok_imagine_image: { p50: 32, p90: 123, n: 179 },
  hunyuan_image_v3: { p50: 122, p90: 158, n: 81 },
  nano_banana_pro: { p50: 41, p90: 66, n: 51 },
  qwen_image: { p50: 28, p90: 47, n: 22 },
  flux_2_dev: { p50: 9, p90: 10, n: 4 },
  nano_banana_2_lite: { p50: 3, p90: 8, n: 0, proxy: 'flux_2_turbo' },
  flux_2_flash: { p50: 3, p90: 8, n: 0, proxy: 'flux_2_turbo' },
  grok_imagine_image_quality: {
    p50: 32,
    p90: 123,
    n: 0,
    proxy: 'grok_imagine_image',
  },
  flux_2_max: { p50: 99, p90: 126, n: 0, proxy: 'gpt_image_2' },
  phota: { p50: 99, p90: 126, n: 0, proxy: 'gpt_image_2' },
  hidream_i1: { p50: 99, p90: 126, n: 0, proxy: 'gpt_image_2' },
  seedream_v5: { p50: 99, p90: 126, n: 0, proxy: 'gpt_image_2' },
} as const satisfies Record<TextToImageModel, WallClock>;

export const AUDIO_WALL_CLOCK = {
  elevenlabs_music: { p50: 10, p90: 14, n: 114 },
  ace_step_1_5: { p50: 33, p90: 59, n: 8 },
  ace_step: { p50: 33, p90: 59, n: 0, proxy: 'ace_step_1_5' },
} as const satisfies Record<AudioModel, WallClock>;

export function videoWallClock(model?: string | null): WallClock {
  if (model && isValidImageToVideoModel(model)) {
    return VIDEO_WALL_CLOCK[model];
  }
  return VIDEO_WALL_CLOCK[DEFAULT_VIDEO_MODEL];
}

export function imageWallClock(model?: string | null): WallClock {
  if (model && isValidTextToImageModel(model)) {
    return IMAGE_WALL_CLOCK[model];
  }
  return IMAGE_WALL_CLOCK[DEFAULT_IMAGE_MODEL];
}

export function audioWallClock(model?: string | null): WallClock {
  if (model && isValidAudioModel(model)) {
    return AUDIO_WALL_CLOCK[model];
  }
  return AUDIO_WALL_CLOCK[DEFAULT_MUSIC_MODEL];
}
