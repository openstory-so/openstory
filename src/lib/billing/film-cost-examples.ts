/**
 * "Typical first film" examples for the public pricing page (#1140).
 *
 * Built from the same estimators as Generate pre-flight, with fixed 30s /
 * 6×5s defaults for a stable showcase (not live script scene count). Returns
 * null when the default image model has no honest pricing signal. Other
 * components may still floor via `estimateStoryboardCost` if those rows are
 * missing from the pricing map.
 *
 * Runtime matches the composer Enhance default (30s), not an orphan 8×5s=40s
 * total that isn't on the duration chip (15s / 30s / 1m / 3m). Showcase uses
 * 6 shots × 5s so wall-clock matches 30s; duration midpoint for a short
 * unenhanced script is 5 — intentional marketing vs preflight difference.
 */

import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  AUDIO_MODELS,
} from '@/lib/ai/models';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import {
  estimateCharacterSheetCount,
  estimateImageCost,
  estimateLocationSheetCount,
  estimateStoryboardCost,
} from '@/lib/billing/cost-estimation';
import { microsToDisplayUsd, type Microdollars } from '@/lib/billing/money';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';

/**
 * Composer default target duration (`script-view` duration chip: 15 / 30 / 60 / 180).
 * Showcase totals use this runtime so pricing matches what users pick on Enhance.
 */
const TARGET_DURATION_S = 30;
/** Typical motion clip length per shot when estimating a 30s board. */
const TYPICAL_SHOT_DURATION_S = 5;
/** Shots so that sceneCount × shotDuration ≈ target (6 × 5s = 30s). */
const TYPICAL_SCENE_COUNT = TARGET_DURATION_S / TYPICAL_SHOT_DURATION_S;
type FilmCostExample = {
  id: string;
  title: string;
  /** One short line under the price, e.g. "30s target · defaults". */
  subtitle: string;
  /** Formatted total, e.g. "~$2.40". */
  cost: string;
  /** Bullet breakdown aligned with the estimator. */
  breakdown: string[];
  /** Raw micros for tests / comparisons. */
  costMicros: Microdollars;
};

export type FilmCostExamples = {
  examples: FilmCostExample[];
  /** e.g. "$20.00" — from SIGNUP_GRANT_MICROS. */
  welcomeCredits: string;
  imageModelName: string;
  videoModelName: string;
  audioModelName: string;
  /** Enhance target duration used for the showcase (seconds). */
  targetDurationSeconds: number;
  sceneCount: number;
  shotDurationSeconds: number;
};

function formatEstimate(micros: Microdollars): string {
  return `~${microsToDisplayUsd(micros)}`;
}

function formatTargetLabel(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? '1m' : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Three tiers: images-only, stills + motion, stills + motion + music.
 * Runtime and defaults align with the Generate / Enhance path (30s target).
 */
export function buildFilmCostExamples(
  pricing: Record<string, EffectiveFalPricing>
): FilmCostExamples | null {
  // Without an honest default-image signal the showcase would either lie
  // (floor) or be empty — prefer hiding the section until pricing is loaded.
  const sampleImage = estimateImageCost(
    DEFAULT_IMAGE_MODEL,
    DEFAULT_ASPECT_RATIO,
    1,
    { pricing }
  );
  if (sampleImage === null) return null;

  const imagesOnly = estimateStoryboardCost({
    imageModel: DEFAULT_IMAGE_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    estimatedSceneCount: TYPICAL_SCENE_COUNT,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    pricing,
  });

  const withMotion = estimateStoryboardCost({
    imageModel: DEFAULT_IMAGE_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    estimatedSceneCount: TYPICAL_SCENE_COUNT,
    autoGenerateMotion: true,
    videoModels: [DEFAULT_VIDEO_MODEL],
    videoDurationSeconds: TYPICAL_SHOT_DURATION_S,
    autoGenerateMusic: false,
    pricing,
  });

  const withMotionAndMusic = estimateStoryboardCost({
    imageModel: DEFAULT_IMAGE_MODEL,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    estimatedSceneCount: TYPICAL_SCENE_COUNT,
    autoGenerateMotion: true,
    videoModels: [DEFAULT_VIDEO_MODEL],
    videoDurationSeconds: TYPICAL_SHOT_DURATION_S,
    autoGenerateMusic: true,
    audioModels: [DEFAULT_MUSIC_MODEL],
    audioDurationSeconds: TARGET_DURATION_S,
    pricing,
  });

  const imageName = IMAGE_MODELS[DEFAULT_IMAGE_MODEL].name;
  const videoName = IMAGE_TO_VIDEO_MODELS[DEFAULT_VIDEO_MODEL].name;
  const audioName = AUDIO_MODELS[DEFAULT_MUSIC_MODEL].name;
  const targetLabel = formatTargetLabel(TARGET_DURATION_S);
  const subtitle = `${targetLabel} target · defaults`;
  const characterSheets = estimateCharacterSheetCount(TYPICAL_SCENE_COUNT);
  const locationSheets = estimateLocationSheetCount(TYPICAL_SCENE_COUNT);

  return {
    welcomeCredits: microsToDisplayUsd(SIGNUP_GRANT_MICROS),
    imageModelName: imageName,
    videoModelName: videoName,
    audioModelName: audioName,
    targetDurationSeconds: TARGET_DURATION_S,
    sceneCount: TYPICAL_SCENE_COUNT,
    shotDurationSeconds: TYPICAL_SHOT_DURATION_S,
    examples: [
      {
        id: 'images-only',
        title: 'Stills',
        subtitle,
        cost: formatEstimate(imagesOnly),
        costMicros: imagesOnly,
        breakdown: [
          // LLM line is a fixed pre-flight stand-in, not live OpenRouter cost.
          `Script analysis (est.)`,
          `${characterSheets} character + ${locationSheets} location sheets`,
          `${TYPICAL_SCENE_COUNT} stills (${imageName})`,
        ],
      },
      {
        id: 'with-motion',
        title: 'Stills + motion',
        subtitle,
        cost: formatEstimate(withMotion),
        costMicros: withMotion,
        breakdown: [
          `Everything in Stills`,
          `${TYPICAL_SCENE_COUNT} × ${TYPICAL_SHOT_DURATION_S}s ${videoName} (with refs)`,
        ],
      },
      {
        id: 'with-motion-music',
        title: 'Stills + motion + music',
        subtitle,
        cost: formatEstimate(withMotionAndMusic),
        costMicros: withMotionAndMusic,
        breakdown: [
          `Everything in Stills + motion`,
          `One ${targetLabel} track (${audioName})`,
        ],
      },
    ],
  };
}
