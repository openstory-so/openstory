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
