/**
 * Cost Estimation Utilities
 * Estimate generation costs before triggering workflows.
 * All functions return Microdollars for exact arithmetic.
 */

import {
  calculateAudioCost,
  calculateImageCost,
  calculateVideoCost,
} from '@/lib/ai/fal-cost';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  type AudioModel,
  type TextToImageModel,
  type ImageToVideoModel,
  videoModelSupportsAudio,
} from '@/lib/ai/models';
import { aspectRatioToDimensions } from '@/lib/constants/aspect-ratios';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { type Microdollars, addMicros, micros, multiplyMicros } from './money';

/**
 * Estimate the raw cost (before markup) of generating images
 */
export function estimateImageCost(
  model: TextToImageModel,
  aspectRatio: AspectRatio,
  numImages: number,
  opts?: {
    resolution?: '0.5K' | '1K' | '2K' | '4K';
    style?: string;
    quality?: string;
    imageSize?: string;
  }
): Microdollars {
  const endpointId = IMAGE_MODELS[model].id;
  const { width, height } = aspectRatioToDimensions(aspectRatio);

  return calculateImageCost({
    endpointId,
    numImages,
    widthPx: width,
    heightPx: height,
    resolution: opts?.resolution,
    style: opts?.style,
    quality: opts?.quality,
    imageSize: opts?.imageSize,
  });
}

/**
 * Estimate the raw cost (before markup) of generating video
 */
export function estimateVideoCost(
  model: ImageToVideoModel,
  durationSeconds: number,
  opts?: { audioEnabled?: boolean; resolution?: string }
): Microdollars {
  const modelConfig = IMAGE_TO_VIDEO_MODELS[model];
  const endpointId = modelConfig.id;

  return calculateVideoCost({
    endpointId,
    durationSeconds,
    audioEnabled: opts?.audioEnabled ?? videoModelSupportsAudio(model),
    resolution: opts?.resolution,
  });
}

/**
 * Estimate the raw cost (before markup) of generating one music track.
 * Internal — used by `estimateStoryboardCost`'s music component.
 */
function estimateAudioCost(
  model: AudioModel,
  durationSeconds: number
): Microdollars {
  return calculateAudioCost({
    endpointId: AUDIO_MODELS[model].id,
    durationSeconds,
  });
}

/**
 * Rough estimate of LLM cost per call for pre-flight credit checks.
 * Based on average token usage for script analysis calls.
 * Only used for client-side gate affordability checks, not actual deduction.
 */
const AVERAGE_LLM_COST_PER_CALL_MICROS = micros(20_000); // $0.02

export function estimateLLMCost(numCalls: number = 1): Microdollars {
  return multiplyMicros(AVERAGE_LLM_COST_PER_CALL_MICROS, numCalls);
}

/** Average scene count for a typical script (used when we can't know in advance) */
const DEFAULT_ESTIMATED_SCENE_COUNT = 8;

/**
 * Estimate the total cost of a storyboard workflow.
 * Includes: LLM analysis, character/location sheet images, per-frame images,
 * and optionally per-frame motion generation.
 */
export function estimateStoryboardCost(opts: {
  imageModel: TextToImageModel;
  /** Number of image models selected (multiplies per-frame image cost) */
  imageModelCount?: number;
  aspectRatio: AspectRatio;
  estimatedSceneCount?: number;
  autoGenerateMotion?: boolean;
  videoModel?: ImageToVideoModel;
  /** Number of video models selected (multiplies per-frame motion cost) */
  videoModelCount?: number;
  videoDurationSeconds?: number;
  autoGenerateMusic?: boolean;
  audioModel?: AudioModel;
  /** Number of audio models selected (multiplies per-sequence music cost) */
  audioModelCount?: number;
  /** Total sequence duration in seconds (one music track spans the sequence) */
  audioDurationSeconds?: number;
}): Microdollars {
  const sceneCount = opts.estimatedSceneCount ?? DEFAULT_ESTIMATED_SCENE_COUNT;
  const imageModelCount = opts.imageModelCount ?? 1;
  const videoModelCount = opts.videoModelCount ?? 1;
  const audioModelCount = opts.audioModelCount ?? 1;

  // LLM calls: script analysis + character bible + location bible (~3 calls)
  const llmCost = estimateLLMCost(3);

  // Character sheets (~3 characters on average, landscape_16_9)
  const characterSheetCost = estimateImageCost(opts.imageModel, '16:9', 3);

  // Location sheets (~3 locations on average, landscape_16_9)
  const locationSheetCost = estimateImageCost(opts.imageModel, '16:9', 3);

  // Per-frame images (multiplied by number of selected image models)
  const frameCost = multiplyMicros(
    estimateImageCost(opts.imageModel, opts.aspectRatio, sceneCount),
    imageModelCount
  );

  let totalCost = addMicros(
    addMicros(addMicros(llmCost, characterSheetCost), locationSheetCost),
    frameCost
  );

  // Optional motion generation for all frames (multiplied by the number of
  // selected video models — each model produces its own video per frame).
  if (opts.autoGenerateMotion && opts.videoModel) {
    const duration = opts.videoDurationSeconds ?? 5;
    const perFrameMotion = estimateVideoCost(opts.videoModel, duration);
    totalCost = addMicros(
      totalCost,
      multiplyMicros(perFrameMotion, sceneCount * videoModelCount)
    );
  }

  // Optional music generation — one track per sequence per audio model.
  if (opts.autoGenerateMusic && opts.audioModel) {
    const audioDuration = opts.audioDurationSeconds ?? sceneCount * 5;
    const perTrackMusic = estimateAudioCost(opts.audioModel, audioDuration);
    totalCost = addMicros(
      totalCost,
      multiplyMicros(perTrackMusic, audioModelCount)
    );
  }

  return totalCost;
}
