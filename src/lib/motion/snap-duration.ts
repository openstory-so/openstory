/**
 * Snap a requested motion duration to a model's valid duration set.
 *
 * Lives in its own module — NOT in `motion-generation.ts` — because client
 * components (shot-duration-field, scene-list) need it, and importing
 * `motion-generation` from the client drags the entire @tanstack/ai adapter
 * family (~9MB in dev) into the browser bundle (#1253). Keep this file free
 * of server-only imports.
 */

import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/lib/ai/models';
import { MOTION_JSON_SCHEMAS } from './endpoint-map';
import { getDurationValues, numericOf, snapTo } from './motion-transform';

/** Allowed clip lengths in seconds for a motion model, sorted ascending.
 *  Non-numeric tokens like `"auto"` are dropped. Empty when the schema has
 *  no duration enum/range (caller should fall back). */
export function durationGridForModel(modelKey: ImageToVideoModel): number[] {
  const endpointId = IMAGE_TO_VIDEO_MODELS[modelKey].id;
  const jsonSchema = MOTION_JSON_SCHEMAS[endpointId];
  const values = getDurationValues(jsonSchema)
    .map(numericOf)
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Snap a requested duration to the nearest valid value for a model.
 *  Reads supported durations from the model's JSON Schema and snaps directly. */
export function snapDuration(
  requested: number | undefined,
  modelKey: ImageToVideoModel
): number {
  const validValues = durationGridForModel(modelKey);
  const firstValue = validValues[0];
  if (firstValue === undefined) return requested ?? 5;

  const target = requested ?? firstValue;
  return numericOf(snapTo(target, validValues));
}

function nextGridUp(
  value: number,
  grid: readonly number[]
): number | undefined {
  return grid.find((x) => x > value);
}

function nextGridDown(
  value: number,
  grid: readonly number[]
): number | undefined {
  for (let i = grid.length - 1; i >= 0; i--) {
    const x = grid[i];
    if (x !== undefined && x < value) return x;
  }
  return undefined;
}

function evenIntegerSplit(count: number, targetSeconds: number): number[] {
  const safeTarget = Math.max(count, Math.round(targetSeconds));
  const base = Math.floor(safeTarget / count);
  let rem = safeTarget - base * count;
  return Array.from({ length: count }, () => {
    const extra = rem > 0 ? 1 : 0;
    rem -= extra;
    return Math.max(1, base + extra);
  });
}

/**
 * Assign one clip length per weight so the sum is as close as possible to
 * `targetSeconds`, using only values from `grid`. Relative weights keep
 * pacing (a longer hint stays longer). When the grid cannot hit the target
 * (7 × min-6s LTX clips cannot be 30s), returns the closest feasible sum.
 */
export function allocateClipDurations(
  weights: readonly number[],
  targetSeconds: number,
  grid: readonly number[]
): number[] {
  const count = weights.length;
  if (count === 0) return [];

  const values = [
    ...new Set(grid.filter((n) => Number.isFinite(n) && n > 0)),
  ].sort((a, b) => a - b);

  if (values.length === 0) {
    return evenIntegerSplit(count, targetSeconds);
  }

  const min = values[0];
  const max = values[values.length - 1];
  if (min === undefined || max === undefined) {
    return evenIntegerSplit(count, targetSeconds);
  }

  const lo = min * count;
  const hi = max * count;
  const goal = Math.min(hi, Math.max(lo, Math.round(targetSeconds)));

  const raw = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1));
  const weightSum = raw.reduce((a, b) => a + b, 0);
  const clips = raw.map((w) =>
    numericOf(snapTo((w / weightSum) * goal, values))
  );

  let sum = clips.reduce((a, b) => a + b, 0);
  let guard = 0;
  const maxSteps = count * values.length + 2;

  while (sum !== goal && guard++ < maxSteps) {
    const needMore = sum < goal;
    const currentErr = Math.abs(sum - goal);
    let bestI = -1;
    let bestNext = 0;
    let bestErr = currentErr;
    let bestEven = needMore
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;

    for (let i = 0; i < count; i++) {
      const cur = clips[i];
      if (cur === undefined) continue;
      const nxt = needMore
        ? nextGridUp(cur, values)
        : nextGridDown(cur, values);
      if (nxt === undefined) continue;
      const err = Math.abs(sum - cur + nxt - goal);
      if (err >= currentErr) continue;
      const betterErr = err < bestErr;
      const betterEven =
        err === bestErr && (needMore ? cur < bestEven : cur > bestEven);
      if (betterErr || betterEven) {
        bestErr = err;
        bestI = i;
        bestNext = nxt;
        bestEven = cur;
      }
    }

    if (bestI < 0) break;
    const cur = clips[bestI];
    if (cur === undefined) break;
    sum += bestNext - cur;
    clips[bestI] = bestNext;
  }

  return clips;
}
