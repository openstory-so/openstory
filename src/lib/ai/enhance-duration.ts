/**
 * Duration arithmetic for script enhancement (#1374).
 *
 * Client-safe: the UI derives the snapped-total chip and the "cannot fit"
 * warning from the same helpers the enhancer uses to constrain labels.
 */

import type { ImageToVideoModel } from '@/lib/ai/models';
import { durationGridForModel, snapDuration } from '@/lib/motion/snap-duration';

/** Enhancer labels: `Scene 3 — 5s` (hyphen / en / em dash). */
const SCENE_DURATION_LINE = /^(Scene\s+\d+\s*)([–—-])(\s*)(\d+)(\s*s\b.*)$/i;

const TOTAL_LINE =
  /^\s*(?:\*{1,2}|#{1,6}\s+)?TOTAL:\s*\d+\s*(?:s|seconds?)?\s*\.?\s*(?:\*{1,2})?\s*$/i;

const TITLE_CARD =
  /\b(title\s*card|end\s*card|logo\s*outro|on[- ]screen\s+text|lower[- ]thirds?)\b|\bSUPER\s*:/i;

/** Trigger a corrective turn when |sum − target| exceeds this fraction. */
const DURATION_SUM_TOLERANCE_RATIO = 0.1;

/** Prompt-level self-check band (±2s in the eval that made the sum reliable). */
const DURATION_PROMPT_TOLERANCE_SECONDS = 2;

export type SceneCountRange = { min: number; max: number };

export type DurationFit = {
  targetSeconds: number;
  labeledSeconds: number | null;
  snappedSeconds: number | null;
  sceneCount: number;
  clipGrid: number[];
  minAchievableSeconds: number | null;
  /** False when labeled scene count × min clip overshoots the target. */
  fits: boolean;
  /** User-facing conflict, or null when the script can hit the target. */
  message: string | null;
};

function preferredSceneRange(targetSeconds: number): SceneCountRange {
  if (targetSeconds <= 15) return { min: 2, max: 3 };
  if (targetSeconds <= 30) return { min: 4, max: 6 };
  if (targetSeconds <= 60) return { min: 8, max: 12 };
  if (targetSeconds <= 120) return { min: 15, max: 20 };
  return { min: 20, max: 30 };
}

export function sceneCountRange(
  targetSeconds: number,
  grid: number[]
): SceneCountRange {
  const preferred = preferredSceneRange(targetSeconds);
  const minClip = grid[0];
  const maxClip = grid[grid.length - 1];
  if (minClip === undefined || maxClip === undefined) return preferred;

  const feasibleMin = Math.max(1, Math.ceil(targetSeconds / maxClip));
  const feasibleMax = Math.max(
    feasibleMin,
    Math.floor(targetSeconds / minClip)
  );
  const min = Math.max(preferred.min, feasibleMin);
  const max = Math.min(preferred.max, feasibleMax);
  if (min <= max) return { min, max };
  return { min: feasibleMin, max: feasibleMax };
}

export function formatSceneRange(range: SceneCountRange): string {
  if (range.min === range.max) return `${range.min}`;
  return `${range.min}-${range.max}`;
}

/** Human clip-grid phrase: "6, 8 or 10 seconds", "4–15 seconds". */
export function formatClipGrid(values: number[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return `${values[0]} seconds`;
  const contiguous = values.every(
    (v, i) => i === 0 || v === (values[i - 1] ?? 0) + 1
  );
  if (contiguous) {
    return `${values[0]}–${values[values.length - 1]} seconds`;
  }
  if (values.length === 2) return `${values[0]} or ${values[1]} seconds`;
  const head = values.slice(0, -1).join(', ');
  return `${head} or ${values[values.length - 1]} seconds`;
}

export function parseSceneDurationLabels(script: string): number[] {
  const labels: number[] = [];
  for (const line of script.split('\n')) {
    const match = line.trim().match(SCENE_DURATION_LINE);
    if (!match?.[4]) continue;
    const seconds = Number(match[4]);
    if (Number.isFinite(seconds) && seconds > 0) labels.push(seconds);
  }
  return labels;
}

export function sumSceneDurations(script: string): number {
  return parseSceneDurationLabels(script).reduce((a, b) => a + b, 0);
}

function isTotalLine(line: string): boolean {
  return TOTAL_LINE.test(line.trim());
}

export function stripTotalLine(script: string): string {
  const lines = script.split('\n');
  const kept = lines.filter((line) => !isTotalLine(line));
  return kept.join('\n').trimEnd();
}

/**
 * Streaming TOTAL-line stripper: hold the incomplete last line so a split
 * `TOTAL:` / ` 30s` pair is dropped rather than leaked to the client.
 */
export function createTotalLineFilter(): {
  push: (delta: string) => string;
  flush: () => string;
} {
  let buf = '';
  return {
    push(delta: string): string {
      buf += delta;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      const out: string[] = [];
      for (const line of lines) {
        if (isTotalLine(line)) continue;
        out.push(line);
      }
      return out.length > 0 ? `${out.join('\n')}\n` : '';
    },
    flush(): string {
      if (!buf) return '';
      if (isTotalLine(buf)) {
        buf = '';
        return '';
      }
      const rest = buf;
      buf = '';
      return rest;
    },
  };
}

function snapToNearest(n: number, grid: number[]): number {
  const first = grid[0];
  if (first === undefined) return n;
  return grid.reduce((best, v) =>
    Math.abs(v - n) < Math.abs(best - n) ? v : best
  );
}

/**
 * Snap each label onto `grid`, then walk individual clips one grid step at a
 * time toward `target` while each step reduces |sum − target|. Stops at the
 * closest achievable sum (e.g. 9×6s = 54s on LTX when the target is 30s).
 */
export function rebalanceDurationsToGrid(
  labels: number[],
  grid: number[],
  target: number
): number[] {
  if (labels.length === 0 || grid.length === 0) return labels;
  const g = [...new Set(grid)].sort((a, b) => a - b);
  const values = labels.map((v) => snapToNearest(v, g));

  const sumOf = () => values.reduce((a, b) => a + b, 0);
  const err = () => Math.abs(sumOf() - target);

  const tryStep = (dir: -1 | 1): boolean => {
    const order = values
      .map((_, i) => i)
      .sort((a, b) => {
        const va = values[a] ?? 0;
        const vb = values[b] ?? 0;
        return dir === -1 ? vb - va : va - vb;
      });
    const before = err();
    for (const i of order) {
      const current = values[i];
      if (current === undefined) continue;
      const idx = g.indexOf(current);
      const next = g[idx + dir];
      if (next === undefined) continue;
      values[i] = next;
      if (err() < before) return true;
      values[i] = current;
    }
    return false;
  };

  while (err() > 0) {
    const dir: -1 | 1 = sumOf() > target ? -1 : 1;
    if (!tryStep(dir)) break;
  }
  return values;
}

function rewriteSceneDurationLabels(
  script: string,
  durations: number[]
): string {
  let i = 0;
  return script
    .split('\n')
    .map((line) => {
      const match = line.match(SCENE_DURATION_LINE);
      if (!match) return line;
      const next = durations[i++];
      if (next === undefined) return line;
      return `${match[1]}${match[2]}${match[3]}${next}${match[5]}`;
    })
    .join('\n');
}

export function durationCorrectionNeeded(opts: {
  labels: number[];
  targetSeconds: number;
  grid: number[];
}): boolean {
  if (opts.labels.length === 0) return false;
  const sum = opts.labels.reduce((a, b) => a + b, 0);
  const offSum =
    Math.abs(sum - opts.targetSeconds) >
    opts.targetSeconds * DURATION_SUM_TOLERANCE_RATIO;
  const offGrid =
    opts.grid.length > 0 && opts.labels.some((s) => !opts.grid.includes(s));
  return offSum || offGrid;
}

/**
 * After the (possibly corrected) LLM pass: rewrite labels onto the model
 * grid when they are illegal or still far from the target. No-op when the
 * labels are already valid and within 10%, so recorded e2e scripts stay put.
 */
export function maybeRewriteDurationLabels(
  script: string,
  targetSeconds: number,
  grid: number[]
): string {
  const labels = parseSceneDurationLabels(script);
  if (labels.length === 0 || grid.length === 0) return script;
  const onGrid = labels.every((s) => grid.includes(s));
  const sum = labels.reduce((a, b) => a + b, 0);
  const closeEnough =
    Math.abs(sum - targetSeconds) <=
    targetSeconds * DURATION_SUM_TOLERANCE_RATIO;
  if (onGrid && closeEnough) return script;
  const next = rebalanceDurationsToGrid(labels, grid, targetSeconds);
  if (next.every((v, i) => v === labels[i])) return script;
  return rewriteSceneDurationLabels(script, next);
}

export function assessDurationFit(
  script: string,
  targetSeconds: number,
  model: ImageToVideoModel
): DurationFit {
  const clipGrid = durationGridForModel(model);
  const labels = parseSceneDurationLabels(script);
  const sceneCount = labels.length;
  const minClip = clipGrid[0];
  if (sceneCount === 0) {
    return {
      targetSeconds,
      labeledSeconds: null,
      snappedSeconds: null,
      sceneCount: 0,
      clipGrid,
      minAchievableSeconds: minClip ?? null,
      fits: true,
      message: null,
    };
  }

  const labeledSeconds = labels.reduce((a, b) => a + b, 0);
  const snapped = rebalanceDurationsToGrid(labels, clipGrid, targetSeconds);
  const snappedSeconds = snapped.reduce((a, b) => a + b, 0);
  const minAchievableSeconds =
    minClip !== undefined ? sceneCount * minClip : snappedSeconds;
  const overshoot =
    minClip !== undefined && minAchievableSeconds > targetSeconds;
  const farFromTarget =
    Math.abs(snappedSeconds - targetSeconds) >
    targetSeconds * DURATION_SUM_TOLERANCE_RATIO;
  const fits = !overshoot && !farFromTarget;
  const message = fits
    ? null
    : formatDurationConflict({
        sceneCount,
        minClip: minClip ?? 0,
        minTotal: minAchievableSeconds,
        targetSeconds,
        snappedSeconds,
      });

  return {
    targetSeconds,
    labeledSeconds,
    snappedSeconds,
    sceneCount,
    clipGrid,
    minAchievableSeconds,
    fits,
    message,
  };
}

function formatDurationConflict(opts: {
  sceneCount: number;
  minClip: number;
  minTotal: number;
  targetSeconds: number;
  snappedSeconds: number;
}): string {
  return (
    `${opts.sceneCount} scenes at ≥${opts.minClip}s clips is ≥${opts.minTotal}s ` +
    `(target ${opts.targetSeconds}s). This video will be about ${opts.snappedSeconds}s. ` +
    `Shorten the brief, pick a model with shorter clips, or raise the target.`
  );
}

export function briefRequestsUnrenderableText(script: string): boolean {
  return TITLE_CARD.test(script);
}

export const TITLE_CARD_NOTE =
  'This brief asks for on-screen text or a title card. The image model cannot render text — Enhance will turn that into a living final beat instead.';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins} minute${mins > 1 ? 's' : ''}`;
  return `${mins} minute${mins > 1 ? 's' : ''} ${secs} seconds`;
}

/** Duration paragraph injected into the enhance user prompt. */
export function buildDurationPromptParagraph(opts: {
  targetSeconds: number;
  videoModel: ImageToVideoModel;
  brief: string;
}): string {
  const grid = durationGridForModel(opts.videoModel);
  const range = sceneCountRange(opts.targetSeconds, grid);
  const rangeText = formatSceneRange(range);
  const gridText = formatClipGrid(grid);
  const titleNote = briefRequestsUnrenderableText(opts.brief)
    ? ' This brief asks for a title card or on-screen text — do not write that card; substitute a final living beat with a real subject (text is not rendered).'
    : ' If the brief asks for a title card, logo, SUPER, or on-screen text, do not write that card — the image model cannot render text. Substitute a final living beat with a real subject.';

  const clipRule =
    gridText.length > 0
      ? `Each scene is one video clip. Clip durations MUST be ${gridText} — those are the only lengths the selected video model can render.`
      : `Give each scene a realistic single-clip duration — most around 5 seconds, a few up to ~8 when the motion genuinely needs it.`;

  return `Target video duration: ${formatDuration(opts.targetSeconds)} (about ${rangeText} scenes). ${clipRule} Label every scene (e.g. a "Scene 3 — ${grid[0] ?? 5}s" heading). The labels MUST add up to ${opts.targetSeconds} seconds (±${DURATION_PROMPT_TOLERANCE_SECONDS} seconds). Count the scenes, add the labels, and do not return until they sum to the target. Reach the target through the number of scenes, not by stretching illegal clip lengths.${titleNote} End with a single line: TOTAL: <sum>s`;
}

export function buildDurationCorrectionPrompt(opts: {
  sum: number;
  targetSeconds: number;
  grid: number[];
  sceneCount: number;
}): string {
  const gridText = formatClipGrid(opts.grid);
  const minClip = opts.grid[0];
  const minTotal = minClip !== undefined ? opts.sceneCount * minClip : opts.sum;
  const cannotFit = minClip !== undefined && minTotal > opts.targetSeconds;
  const clipRule =
    gridText.length > 0
      ? `Each clip duration MUST be one of: ${gridText}.`
      : '';
  const action = cannotFit
    ? `${opts.sceneCount} scenes at ≥${minClip}s is at least ${minTotal}s. Drop or merge beats so the labels add up to ${opts.targetSeconds}s (±${DURATION_PROMPT_TOLERANCE_SECONDS}s).`
    : `Revise the durations and/or scene count so the labels add up to ${opts.targetSeconds}s (±${DURATION_PROMPT_TOLERANCE_SECONDS}s).`;
  return `Your scene duration labels sum to ${opts.sum}s, but the target is ${opts.targetSeconds}s. ${clipRule} ${action} Keep the story. If the brief asked for a title card, keep the living-beat substitution — do not write a title card. End with a single line: TOTAL: <sum>s. Return ONLY the revised script.`;
}

/**
 * Per-shot / total seconds for credit estimates: labeled scenes snapped to
 * the model grid when present, otherwise the target spread across the
 * estimated scene count and snapped.
 */
export function estimateMotionDurations(opts: {
  script: string;
  targetSeconds: number;
  sceneCount: number;
  model: ImageToVideoModel;
}): { perShotSeconds: number; totalSeconds: number } {
  const labels = parseSceneDurationLabels(opts.script);
  if (labels.length > 0) {
    const snapped = labels.map((s) => snapDuration(s, opts.model));
    const totalSeconds = snapped.reduce((a, b) => a + b, 0);
    return {
      perShotSeconds: Math.max(1, Math.round(totalSeconds / snapped.length)),
      totalSeconds,
    };
  }
  const raw = Math.max(
    1,
    Math.round(opts.targetSeconds / Math.max(opts.sceneCount, 1))
  );
  const perShotSeconds = snapDuration(raw, opts.model);
  return {
    perShotSeconds,
    totalSeconds: perShotSeconds * Math.max(opts.sceneCount, 1),
  };
}
