/**
 * Render segments (#990) — tiling a scene into ≤cap render units.
 *
 * The render unit is NOT the scene: a render model caps a single render at a
 * per-model duration (15s for current models, 30s for newer ones), so a scene's
 * video is an ordered tiling of **segments**, each a contiguous shot-subset
 * whose total duration is ≤ the model cap. The common case (scene ≤ cap) is one
 * segment = the whole scene; long scenes split; per-shot rendering is the
 * degenerate case (one shot per segment).
 *
 * A segment is a persisted `render_segments` row; its `id` (with the model) is
 * the key under which `video_variants` versions for that segment accumulate. Its
 * membership is the ordered shotIds it covers (`shots.renderSegmentId`).
 *
 * The cap is sourced per-model from the model's JSON Schema duration set (the
 * same source `snapDuration` snaps to), never a hardcoded constant.
 * `packMotionBatchShots` is the live caller (#1510).
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/models/models';
import {
  DEFAULT_SEGMENT_CAP_MS,
  tileSceneIntoSegments,
  type SegmentShot,
} from '@/motion/tile-segments';
import type {
  VideoManifest,
  VideoManifestEntry,
} from '@/platform/server/db/schema';
import { MOTION_JSON_SCHEMAS } from './endpoint-map';
import { getDurationValues, numericOf } from './motion-transform';

export { DEFAULT_SEGMENT_CAP_MS, tileSceneIntoSegments, type SegmentShot };

function durationValuesForModel(model: ImageToVideoModel): number[] {
  const endpointId = IMAGE_TO_VIDEO_MODELS[model].id;
  const jsonSchema = MOTION_JSON_SCHEMAS[endpointId];
  return getDurationValues(jsonSchema).map(numericOf);
}

/**
 * The maximum single-render duration (ms) for a model — the largest value in
 * its valid duration set. This is the segment cap: a render may cover multiple
 * shots only while their total stays at or under it. Falls back to
 * {@link DEFAULT_SEGMENT_CAP_MS} when the schema exposes no durations.
 */
export function resolveSegmentCapMs(model: ImageToVideoModel): number {
  const values = durationValuesForModel(model);
  if (values.length === 0) return DEFAULT_SEGMENT_CAP_MS;
  return Math.max(...values) * 1000;
}

/**
 * The shortest clip (ms) this model will accept. Leftover tiles under this
 * floor snap up (or the leftover dropdown routes them to Grok). 0 when the
 * schema exposes no durations — same "no floor" as a missing min on the tiler.
 */
export function resolveSegmentMinMs(model: ImageToVideoModel): number {
  const values = durationValuesForModel(model).filter((n) => n > 0);
  if (values.length === 0) return 0;
  return Math.min(...values) * 1000;
}

/**
 * Assemble a render manifest from ordered per-shot snapshots — the named seam
 * where a `VideoManifest` is constructed. Each entry references the immutable
 * `shot_prompt_versions` / `frame_variants` rows the render consumed (the
 * reference is the snapshot) plus the value-snapshot `durationMs`. Returns a
 * shallow copy (so callers can't mutate it post-build) without re-listing
 * fields, so a future `VideoManifestEntry` field flows through untouched.
 */
export function buildVideoManifest(
  entries: readonly VideoManifestEntry[]
): VideoManifest {
  return entries.map((e) => ({ ...e }));
}
