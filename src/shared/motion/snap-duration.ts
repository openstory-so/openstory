/**
 * Snap a requested motion duration to a model's valid duration set.
 *
 * Lives in its own module — NOT in `motion-generation.ts` — because client
 * components (shot-duration-field, scene-list) need it, and importing
 * `motion-generation` from the client drags the entire @tanstack/ai adapter
 * family (~9MB in dev) into the browser bundle (#1253). Keep this file free
 * of server-only imports.
 */

import type { ImageToVideoModel } from '@/shared/ai/models';
import { durationGridForModel } from './model-capabilities';

export { durationGridForModel };

/** Snap a requested duration to the nearest valid value for a model. */
export function snapDuration(
  requested: number | undefined,
  modelKey: ImageToVideoModel
): number {
  const validValues = durationGridForModel(modelKey);
  const firstValue = validValues[0];
  if (firstValue === undefined) return requested ?? 5;

  const target = requested ?? firstValue;
  return validValues.reduce((prev, curr) =>
    Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
  );
}
