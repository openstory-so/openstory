/**
 * Fixed time estimates for generation phases based on scene count.
 * Used to show a countdown timer in the generation progress banner.
 *
 * Scene count also feeds pre-flight credit estimates (#1140). Prefer counting
 * explicit scene labels from Enhance ("Scene 3 — 5s") over word-density
 * heuristics — enhanced scripts are dense and short per scene, so words/120
 * badly undercounts (e.g. 29 labeled scenes → ~8 by words → ~⅓ the real cost).
 */

// Calibrated against a real-provider 11-scene run (2026-08-20, grok-4.6
// analysis + seedance_v2 motion): phases measured 151s / 25s / 95s / 130s /
// 328–487s. Phase 1's scene-split output scales with scene count (~13s/scene
// observed); phases 3–4 are parallel per scene so only their slowest call
// paces them; phase 5's per-scene term tracks the completion tail widening as
// the parallel clip batch grows.
const PHASE_BUDGETS = [
  { base: 30, perScene: 12 }, // 1. Script analysis (scene-split output scales with scenes)
  { base: 20, perScene: 1 }, // 2. Casting (LLM input scales with scenes)
  { base: 100, perScene: 0 }, // 3. Sheets + visual prompts (all parallel per scene)
  { base: 135, perScene: 0 }, // 4. Images + motion/music prompts (images, then vision-conditioned motion prompts)
  { base: 330, perScene: 15 }, // 5. Motion/music generation (optional; parallel, tail grows with batch size)
] as const;

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
  return 25;
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

function phaseBudget(phaseIndex: number, sceneCount: number): number {
  const budget = PHASE_BUDGETS[phaseIndex];
  if (!budget) return 0;
  return budget.base + budget.perScene * sceneCount;
}

export function estimateTotalSeconds(
  sceneCount: number,
  estimatedSceneCount?: number,
  phaseCount: number = PHASE_BUDGETS.length
): number {
  const fallback = estimatedSceneCount ?? DEFAULT_SCENE_COUNT;
  const scenes = sceneCount > 0 ? sceneCount : fallback;
  let total = 0;
  for (let i = 0; i < Math.min(phaseCount, PHASE_BUDGETS.length); i++) {
    const b = PHASE_BUDGETS[i];
    if (!b) continue;
    total += b.base + b.perScene * scenes;
  }
  return total;
}

export function estimateRemainingSeconds(opts: {
  sceneCount: number;
  completedPhases: number[];
  elapsedSeconds: number;
  estimatedSceneCount?: number;
}): number {
  const fallback = opts.estimatedSceneCount ?? DEFAULT_SCENE_COUNT;
  const scenes = opts.sceneCount > 0 ? opts.sceneCount : fallback;
  const completedSet = new Set(opts.completedPhases);

  let remaining = 0;
  for (let i = 0; i < PHASE_BUDGETS.length; i++) {
    const phaseNumber = i + 1;
    if (!completedSet.has(phaseNumber)) {
      remaining += phaseBudget(i, scenes);
    }
  }

  return Math.max(0, remaining);
}

export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'Finishing up\u2026';
  if (seconds < 60) return `${seconds}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const paddedSecs = secs.toString().padStart(2, '0');
  return `${minutes}:${paddedSecs} remaining`;
}
