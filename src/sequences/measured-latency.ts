/**
 * Wall-clock seconds per completed generation, from production D1: each
 * `video_variants` / `frame_variants` row's `created_at` → `generated_at`,
 * 30 days ending 2026-09-11 (#1559). That is the time a user actually waits
 * for one clip or still — fal queueing and Ark asset pacing included.
 *
 * It replaced PostHog's `gen_ai.client.operation.duration`, which reported
 * H3 Max at 10s / 10s over 74 samples when production renders take 22s / 73s
 * — the countdown hit zero and sat on "Finishing up…". Rows copied from a
 * sibling were similarly wrong: Seedance 2.5 borrowed 2.0's 208 / 288 and
 * really takes 293 / 466.
 *
 * `n` is completed generations. `p50` / `p90` are seconds. Re-run the query
 * rather than editing numbers by hand. Rows marked `pre-D1` keep their PostHog
 * figure: those models write their row only on completion, so D1 reads 0s.
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
} from '@/models/models';

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
  grok_imagine_video_1_5: { p50: 37, p90: 43, n: 20 },
  // No samples yet; Grok Imagine is the nearest fast native-provider i2v.
  gemini_omni_flash: { p50: 68, p90: 114, n: 55 },
  ltx_2_3_pro: { p50: 128, p90: 201, n: 40 },
  veo3_1: { p50: 155, p90: 166, n: 6 },
  kling_v3_pro: { p50: 233, p90: 573, n: 17 },
  minimax_hailuo_02: { p50: 204, p90: 234, n: 14 },
  minimax_h3_max: { p50: 22, p90: 73, n: 427 },
  seedance_v2: { p50: 211, p90: 289, n: 631 },
  seedance_v2_5: { p50: 293, p90: 466, n: 11 },
  seedance_v2_mini: { p50: 120, p90: 180, n: 0, proxy: 'seedance_v2' },
} as const satisfies Record<ImageToVideoModel, WallClock>;

export const IMAGE_WALL_CLOCK = {
  gpt_image_2: { p50: 106, p90: 127, n: 1700 },
  krea_2_turbo: { p50: 3, p90: 3, n: 1326 }, // pre-D1
  flux_2_turbo: { p50: 3, p90: 8, n: 585 }, // pre-D1
  nano_banana_2: { p50: 32, p90: 50, n: 179 },
  grok_imagine_image: { p50: 34, p90: 48, n: 103 },
  hunyuan_image_v3: { p50: 133, p90: 169, n: 58 },
  nano_banana_pro: { p50: 49, p90: 77, n: 48 },
  qwen_image: { p50: 46, p90: 55, n: 11 },
  flux_2_dev: { p50: 9, p90: 10, n: 4 },
  nano_banana_2_lite: { p50: 15, p90: 29, n: 305 },
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
  elevenlabs_music: { p50: 10, p90: 14, n: 114 }, // pre-D1
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
