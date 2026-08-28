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

export type DurationFit = {
  snappedSeconds: number | null;
  clipGrid: number[];
  /** Set only when scene count × min clip overshoots the target. */
  message: string | null;
};

function preferredMinMax(targetSeconds: number): [number, number] {
  if (targetSeconds <= 15) return [2, 3];
  if (targetSeconds <= 30) return [4, 6];
  if (targetSeconds <= 60) return [8, 12];
  if (targetSeconds <= 120) return [15, 20];
  return [20, 30];
}

/** Scene-count guidance, intersected with what the clip grid can actually hit. */
export function sceneRangeText(targetSeconds: number, grid: number[]): string {
  let [min, max] = preferredMinMax(targetSeconds);
  const minClip = grid[0];
  const maxClip = grid[grid.length - 1];
  if (minClip !== undefined && maxClip !== undefined) {
    const feasibleMin = Math.max(1, Math.ceil(targetSeconds / maxClip));
    const feasibleMax = Math.max(
      feasibleMin,
      Math.floor(targetSeconds / minClip)
    );
    const lo = Math.max(min, feasibleMin);
    const hi = Math.min(max, feasibleMax);
    if (lo <= hi) {
      min = lo;
      max = hi;
    } else {
      min = feasibleMin;
      max = feasibleMax;
    }
  }
  return min === max ? `${min}` : `${min}-${max}`;
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

/** Snap illegal labels onto the model grid. On-grid values are left alone. */
export function maybeRewriteDurationLabels(
  script: string,
  model: ImageToVideoModel
): string {
  const labels = parseSceneDurationLabels(script);
  if (labels.length === 0) return script;
  const next = labels.map((s) => snapDuration(s, model));
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
  const minClip = clipGrid[0];
  if (labels.length === 0) {
    return { snappedSeconds: null, clipGrid, message: null };
  }

  const snapped = labels.map((s) => snapDuration(s, model));
  const snappedSeconds = snapped.reduce((a, b) => a + b, 0);
  // Only "too many scenes for this model's shortest clip" — never "too few
  // yet" (that fires on a half-streamed enhance and then vanishes).
  const minTotal = minClip !== undefined ? labels.length * minClip : 0;
  const message =
    minClip !== undefined && minTotal > targetSeconds
      ? `${labels.length} scenes at ≥${minClip}s clips is ≥${minTotal}s ` +
        `(target ${targetSeconds}s). This video will be about ${snappedSeconds}s. ` +
        `Shorten the brief, pick a model with shorter clips, or raise the target.`
      : null;

  return { snappedSeconds, clipGrid, message };
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
}): string {
  const grid = durationGridForModel(opts.videoModel);
  const rangeText = sceneRangeText(opts.targetSeconds, grid);
  const gridText = formatClipGrid(grid);
  const clipRule =
    gridText.length > 0
      ? `Each scene is one video clip. Clip durations MUST be ${gridText} — those are the only lengths the selected video model can render.`
      : `Give each scene a realistic single-clip duration — most around 5 seconds, a few up to ~8 when the motion genuinely needs it.`;

  return `Target video duration: ${formatDuration(opts.targetSeconds)} (about ${rangeText} scenes). ${clipRule} Label every scene (e.g. a "Scene 3 — ${grid[0] ?? 5}s" heading). The labels MUST add up to ${opts.targetSeconds} seconds (±${DURATION_PROMPT_TOLERANCE_SECONDS} seconds). Count the scenes, add the labels, and do not return until they sum to the target. Reach the target through the number of scenes, not by stretching illegal clip lengths. If the brief asks for a title card, logo, SUPER, or on-screen text, do not write that card — the image model cannot render text. Substitute a final living beat with a real subject. End with a single line: TOTAL: <sum>s`;
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
