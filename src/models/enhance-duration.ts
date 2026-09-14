/**
 * Duration arithmetic for script enhancement (#1374).
 *
 * Client-safe: the UI derives the snapped-total chip from the same helpers the
 * enhancer uses to constrain labels.
 */

import type { ImageToVideoModel } from './models';
import { durationGridForModel, snapDuration } from '@/motion/snap-duration';

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
};

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

/**
 * Scene labels are narrative time, not clip lengths (#1621) — there is no
 * model grid to be "off" against here. Only the sum-vs-target check applies.
 */
export function durationCorrectionNeeded(opts: {
  labels: number[];
  targetSeconds: number;
}): boolean {
  if (opts.labels.length === 0) return false;
  const sum = opts.labels.reduce((a, b) => a + b, 0);
  return (
    Math.abs(sum - opts.targetSeconds) >
    opts.targetSeconds * DURATION_SUM_TOLERANCE_RATIO
  );
}

/**
 * What the script's own labels render to on this model's grid. There is
 * deliberately no "cannot fit the target" verdict here (#1523, #1593): the
 * target steers Enhance and the estimate, never generation — each scene's
 * shots divide its own label — so an overshoot is a length, not a fault.
 */
export function assessDurationFit(
  script: string,
  model: ImageToVideoModel
): DurationFit {
  const clipGrid = durationGridForModel(model);
  const labels = parseSceneDurationLabels(script);
  if (labels.length === 0) {
    return { snappedSeconds: null, clipGrid };
  }

  const snapped = labels.map((s) => snapDuration(s, model));
  return { snappedSeconds: snapped.reduce((a, b) => a + b, 0), clipGrid };
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

/**
 * Duration paragraph injected into the enhance user prompt. Scene-only
 * (#1621): Enhance writes narrative scene lengths, never clip lengths — it
 * does not know the video model's grid. Coverage (how many shots a scene
 * needs, and their legal lengths) is decided later, by the shot-list pass.
 */
export function buildDurationPromptParagraph(opts: {
  targetSeconds: number;
}): string {
  const exampleSeconds = Math.max(4, Math.round(opts.targetSeconds / 4));

  return `Target video duration: ${formatDuration(opts.targetSeconds)}. Group content that shares a location and beat into one scene. Label every scene with its intended duration (e.g. a "Scene 3 — ${exampleSeconds}s" heading) — that is the scene's playing time, not a clip length. Scene labels MUST add up to ${opts.targetSeconds} seconds (±${DURATION_PROMPT_TOLERANCE_SECONDS} seconds). Count the scenes, add the labels, and do not return until they sum to the target. Reach the target through the number of scenes, not by stretching one scene's length. If the brief asks for a title card, logo, SUPER, or on-screen text, do not write that card — the image model cannot render text. Substitute a final living beat with a real subject. End with a single line: TOTAL: <sum>s`;
}

export function buildDurationCorrectionPrompt(opts: {
  sum: number;
  targetSeconds: number;
  sceneCount: number;
}): string {
  return `Your scene duration labels sum to ${opts.sum}s, but the target is ${opts.targetSeconds}s. Revise the durations and/or scene count so the labels add up to ${opts.targetSeconds}s (±${DURATION_PROMPT_TOLERANCE_SECONDS}s). Keep the story. If the brief asked for a title card, keep the living-beat substitution — do not write a title card. End with a single line: TOTAL: <sum>s. Return ONLY the revised script.`;
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
