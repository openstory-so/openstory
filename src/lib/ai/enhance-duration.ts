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

/** Multi-shot labels: `Shot 1 — 6s`. Clip-grid arithmetic uses these when present. */
const SHOT_DURATION_LINE = /^(Shot\s+\d+\s*)([–—-])(\s*)(\d+)(\s*s\b.*)$/i;

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

/** Clip-count guidance (shots, or one-shot scenes), intersected with the grid. */
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

function parseLabeledDurations(script: string, pattern: RegExp): number[] {
  const labels: number[] = [];
  for (const line of script.split('\n')) {
    const match = line.trim().match(pattern);
    if (!match?.[4]) continue;
    const seconds = Number(match[4]);
    if (Number.isFinite(seconds) && seconds > 0) labels.push(seconds);
  }
  return labels;
}

export function parseSceneDurationLabels(script: string): number[] {
  return parseLabeledDurations(script, SCENE_DURATION_LINE);
}

export function parseShotDurationLabels(script: string): number[] {
  return parseLabeledDurations(script, SHOT_DURATION_LINE);
}

/**
 * Clip durations for grid/sum arithmetic: shot labels when the writer
 * emitted them, otherwise scene labels (a one-shot scene's heading IS the
 * clip). Never sum both — that would double-count.
 */
export function parseClipDurationLabels(script: string): number[] {
  const shots = parseShotDurationLabels(script);
  if (shots.length > 0) return shots;
  return parseSceneDurationLabels(script);
}

export function sumSceneDurations(script: string): number {
  return parseClipDurationLabels(script).reduce((a, b) => a + b, 0);
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

function rewriteLabeledDurations(
  script: string,
  pattern: RegExp,
  durations: number[]
): string {
  let i = 0;
  return script
    .split('\n')
    .map((line) => {
      const match = line.match(pattern);
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

/** Snap illegal clip labels onto the model grid. On-grid values are left alone. */
export function maybeRewriteDurationLabels(
  script: string,
  model: ImageToVideoModel
): string {
  const shotLabels = parseShotDurationLabels(script);
  if (shotLabels.length > 0) {
    const next = shotLabels.map((s) => snapDuration(s, model));
    if (next.every((v, i) => v === shotLabels[i])) return script;
    return rewriteLabeledDurations(script, SHOT_DURATION_LINE, next);
  }
  const labels = parseSceneDurationLabels(script);
  if (labels.length === 0) return script;
  const next = labels.map((s) => snapDuration(s, model));
  if (next.every((v, i) => v === labels[i])) return script;
  return rewriteLabeledDurations(script, SCENE_DURATION_LINE, next);
}

export function assessDurationFit(
  script: string,
  targetSeconds: number,
  model: ImageToVideoModel
): DurationFit {
  const clipGrid = durationGridForModel(model);
  const shotLabels = parseShotDurationLabels(script);
  const usingShots = shotLabels.length > 0;
  const labels = usingShots ? shotLabels : parseSceneDurationLabels(script);
  const minClip = clipGrid[0];
  if (labels.length === 0) {
    return { snappedSeconds: null, clipGrid, message: null };
  }

  const snapped = labels.map((s) => snapDuration(s, model));
  const snappedSeconds = snapped.reduce((a, b) => a + b, 0);
  // Only "too many clips for this model's shortest clip" — never "too few
  // yet" (that fires on a half-streamed enhance and then vanishes).
  const minTotal = minClip !== undefined ? labels.length * minClip : 0;
  const unit = usingShots ? 'shots' : 'scenes';
  const message =
    minClip !== undefined && minTotal > targetSeconds
      ? `${labels.length} ${unit} at ≥${minClip}s clips is ≥${minTotal}s ` +
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
  const pace =
    gridText.length > 0
      ? `Keep each continuous take short enough to play in ${gridText} — those are the clip lengths the selected video model can render.`
      : `Keep each continuous take short — most around 5 seconds, a few up to ~8 when the motion needs it.`;

  return `Target running time: ${formatDuration(opts.targetSeconds)} (about ${rangeText} locations/beats). Write a Fountain screenplay that would play at that length — denser, not padded. A new INT./EXT. slugline is a new location or time, not a new camera angle. ${pace} Do not stamp seconds on headings and do not write a TOTAL line. If the brief asks for a title card, logo, SUPER, or on-screen text, do not write that card — substitute a living final beat with a real subject.`;
}

export function buildDurationCorrectionPrompt(opts: {
  sum: number;
  targetSeconds: number;
  grid: number[];
  sceneCount: number;
  /** True when the labels being corrected are `Shot N — Xs`. */
  usingShotLabels?: boolean;
}): string {
  const gridText = formatClipGrid(opts.grid);
  const minClip = opts.grid[0];
  const minTotal = minClip !== undefined ? opts.sceneCount * minClip : opts.sum;
  const cannotFit = minClip !== undefined && minTotal > opts.targetSeconds;
  const unit = opts.usingShotLabels ? 'shots' : 'scenes';
  const clipRule =
    gridText.length > 0
      ? `Each clip duration MUST be one of: ${gridText}.`
      : '';
  const action = cannotFit
    ? `${opts.sceneCount} ${unit} at ≥${minClip}s is at least ${minTotal}s. Drop or merge beats so the labels add up to ${opts.targetSeconds}s (±${DURATION_PROMPT_TOLERANCE_SECONDS}s).`
    : `Revise the durations and/or ${opts.usingShotLabels ? 'shot' : 'scene'} count so the labels add up to ${opts.targetSeconds}s (±${DURATION_PROMPT_TOLERANCE_SECONDS}s).`;
  return `Your clip duration labels sum to ${opts.sum}s, but the target is ${opts.targetSeconds}s. ${clipRule} ${action} Keep the story. If the brief asked for a title card, keep the living-beat substitution — do not write a title card. End with a single line: TOTAL: <sum>s. Return ONLY the revised script.`;
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
  const labels = parseClipDurationLabels(opts.script);
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
