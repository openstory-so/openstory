/**
 * Time estimates for generation phases based on scene count + selected models.
 * Used to show a countdown timer in the generation progress banner.
 *
 * Scene count also feeds pre-flight credit estimates (#1140). Prefer counting
 * explicit scene labels from Enhance ("Scene 3 — 5s") over word-density
 * heuristics — enhanced scripts are dense and short per scene, so words/120
 * badly undercounts (e.g. 29 labeled scenes → ~8 by words → ~⅓ the real cost).
 */

import { isTurboImageModel } from '@/lib/ai/generation-mode';
import {
  ANALYSIS_FAST,
  ANALYSIS_QUALITY,
  CASTING_FAST,
  CASTING_QUALITY,
  FAL_MOTION_CONCURRENCY,
  MOTION_PROMPT_P90_SECONDS,
  VISUAL_PROMPT_P90_SECONDS,
  audioWallClock,
  imageWallClock,
  videoWallClock,
} from '@/lib/generation/measured-latency';

type PhaseBudget = { base: number; perScene: number };

export type TimeEstimateModels = {
  imageModel?: string | null;
  videoModel?: string | null;
  musicModel?: string | null;
};

/**
 * Parallel fal waves: one wave waits p90 of a single clip; each extra wave
 * adds another p50. Concurrency 6 is the fit to Seedance 11-scene wall
 * clocks (328–487s) vs p90 288s + p50 208s.
 */
export function estimateMotionSeconds(
  videoModel: string | null | undefined,
  shotCount: number
): number {
  const { p50, p90 } = videoWallClock(videoModel);
  const n = Math.max(1, shotCount);
  const waves = Math.ceil(n / FAL_MOTION_CONCURRENCY);
  return Math.round(p90 + Math.max(0, waves - 1) * p50);
}

export function estimateMusicSeconds(musicModel?: string | null): number {
  return audioWallClock(musicModel).p90;
}

function phaseBudgets(models?: TimeEstimateModels): readonly PhaseBudget[] {
  const image = imageWallClock(models?.imageModel);
  const fastAnalysis = Boolean(
    models?.imageModel && isTurboImageModel(models.imageModel)
  );
  const analysis = fastAnalysis ? ANALYSIS_FAST : ANALYSIS_QUALITY;
  const casting = fastAnalysis ? CASTING_FAST : CASTING_QUALITY;
  const sheets = Math.max(VISUAL_PROMPT_P90_SECONDS, image.p90);
  const stillsThenMotionPrompts = image.p90 + MOTION_PROMPT_P90_SECONDS;

  return [
    analysis,
    casting,
    { base: sheets, perScene: 0 },
    { base: stillsThenMotionPrompts, perScene: 0 },
  ];
}

const WORDS_PER_SCENE = 120;
const MIN_SCENES = 1;
const MAX_SCENES = 30;
const DEFAULT_SCENE_COUNT = 6;

/**
 * Numbered enhance-style headings: "Scene 1", "Scene 12 — 5s", "**Scene 3:**".
 * Case-insensitive; must start a line (after optional markdown).
 */
const NUMBERED_SCENE_HEADING =
  /(?:^|\n)[ \t]*(?:\*{1,2}|#{1,6}\s+)?Scene\s+(\d+)\b/gi;

/** Fountain / screenplay sluglines. */
const FOUNTAIN_SCENE_HEADING =
  /(?:^|\n)[ \t]*(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)[\s./]/gi;

/**
 * Count structural scene markers already in the script (post-Enhance).
 * Returns 0 when none are found so callers can fall back.
 */
export function countScriptSceneHeadings(script: string): number {
  if (!script.trim()) return 0;

  const numbered = new Set<number>();
  for (const match of script.matchAll(NUMBERED_SCENE_HEADING)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) numbered.add(n);
  }
  if (numbered.size > 0) {
    // Prefer distinct scene numbers over raw match count (re-mentions of
    // "Scene 1" in body text shouldn't inflate).
    return numbered.size;
  }

  const fountain = script.match(FOUNTAIN_SCENE_HEADING);
  return fountain?.length ?? 0;
}

/**
 * Midpoint of the enhance prompt's scene-range guidance for a target duration.
 * Used when the script has no labeled scenes yet (pre-Enhance one-liner).
 */
export function estimateSceneCountFromDuration(
  targetDurationSeconds: number
): number {
  if (targetDurationSeconds <= 15) return 3;
  if (targetDurationSeconds <= 30) return 5;
  if (targetDurationSeconds <= 60) return 10;
  if (targetDurationSeconds <= 120) return 18;
  if (targetDurationSeconds <= 180) return 25;
  return 30;
}

function estimateSceneCountFromWords(script: string): number {
  const wordCount = script.trim().split(/\s+/).filter(Boolean).length;
  const estimated = Math.round(wordCount / WORDS_PER_SCENE);
  return Math.max(MIN_SCENES, Math.min(MAX_SCENES, estimated));
}

/**
 * Best available scene (≈ shot image) count for estimates.
 *
 * Priority:
 * 1. Explicit Scene N / INT.EXT headings in the script (Enhance output)
 * 2. Max of word-density heuristic and target-duration midpoint (pre-Enhance)
 * 3. Word density alone
 */
export function estimateSceneCount(
  script: string,
  opts?: { targetDurationSeconds?: number }
): number {
  const labeled = countScriptSceneHeadings(script);
  if (labeled > 0) {
    return Math.max(MIN_SCENES, Math.min(MAX_SCENES, labeled));
  }

  const fromWords = estimateSceneCountFromWords(script);
  if (opts?.targetDurationSeconds != null && opts.targetDurationSeconds > 0) {
    const fromDuration = estimateSceneCountFromDuration(
      opts.targetDurationSeconds
    );
    // Before Enhance, duration is the user's intent — take the higher of
    // density vs duration so a short one-liner with "3 min" doesn't estimate
    // as a single scene.
    return Math.max(
      MIN_SCENES,
      Math.min(MAX_SCENES, Math.max(fromWords, fromDuration))
    );
  }

  return fromWords;
}

const MOTION_PHASE_INDEX = 4;
const PIPELINE_PHASE_COUNT = 5;

function motionMusicSeconds(
  sceneCount: number,
  models?: TimeEstimateModels
): number {
  return Math.max(
    estimateMotionSeconds(models?.videoModel, sceneCount),
    estimateMusicSeconds(models?.musicModel)
  );
}

function phaseBudget(
  phaseIndex: number,
  sceneCount: number,
  models?: TimeEstimateModels
): number {
  if (phaseIndex === MOTION_PHASE_INDEX) {
    return motionMusicSeconds(sceneCount, models);
  }
  const budget = phaseBudgets(models)[phaseIndex];
  if (!budget) return 0;
  return budget.base + budget.perScene * sceneCount;
}

export function estimateTotalSeconds(
  sceneCount: number,
  estimatedSceneCount?: number,
  phaseCount?: number,
  models?: TimeEstimateModels
): number {
  const phases = phaseCount ?? PIPELINE_PHASE_COUNT;
  const fallback = estimatedSceneCount ?? DEFAULT_SCENE_COUNT;
  const scenes = sceneCount > 0 ? sceneCount : fallback;
  let total = 0;
  for (let i = 0; i < phases; i++) {
    total += phaseBudget(i, scenes, models);
  }
  return total;
}

export function estimateRemainingSeconds(opts: {
  sceneCount: number;
  completedPhases: number[];
  elapsedSeconds: number;
  estimatedSceneCount?: number;
  imageModel?: string | null;
  videoModel?: string | null;
  musicModel?: string | null;
}): number {
  const models = {
    imageModel: opts.imageModel,
    videoModel: opts.videoModel,
    musicModel: opts.musicModel,
  };
  const fallback = opts.estimatedSceneCount ?? DEFAULT_SCENE_COUNT;
  const scenes = opts.sceneCount > 0 ? opts.sceneCount : fallback;
  const completedSet = new Set(opts.completedPhases);

  let remaining = 0;
  for (let i = 0; i < PIPELINE_PHASE_COUNT; i++) {
    if (!completedSet.has(i + 1)) {
      remaining += phaseBudget(i, scenes, models);
    }
  }

  return Math.max(0, remaining);
}

export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'Finishing up\u2026';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const paddedSecs = secs.toString().padStart(2, '0');
  return `${minutes}:${paddedSecs}`;
}
