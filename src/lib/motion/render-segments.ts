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
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import {
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
} from '@/shared/ai/models';
import type { VideoManifest, VideoManifestEntry } from '@/lib/db/schema';
import { MOTION_JSON_SCHEMAS } from '@/shared/motion/endpoint-map';
import { getDurationValues, numericOf } from '@/shared/motion/motion-transform';

/** Fallback segment cap when a model's schema exposes no duration set. */
export const DEFAULT_SEGMENT_CAP_MS = 15_000;

/** A shot as the tiler sees it: an id and its duration. */
export type SegmentShot = {
  id: string;
  durationMs: number;
};

/** A tiled segment: the ordered shots it covers and their summed duration. */
export type TiledSegment = {
  shotIds: string[];
  durationMs: number;
};

/**
 * The maximum single-render duration (ms) for a model — the largest value in
 * its valid duration set. This is the segment cap: a render may cover multiple
 * shots only while their total stays at or under it. Falls back to
 * {@link DEFAULT_SEGMENT_CAP_MS} when the schema exposes no durations.
 */
export function resolveSegmentCapMs(model: ImageToVideoModel): number {
  const endpointId = IMAGE_TO_VIDEO_MODELS[model].id;
  const jsonSchema = MOTION_JSON_SCHEMAS[endpointId];
  const values = getDurationValues(jsonSchema).map(numericOf);
  if (values.length === 0) return DEFAULT_SEGMENT_CAP_MS;
  return Math.max(...values) * 1000;
}

/**
 * Tile an ordered list of shots into contiguous segments, each ≤ `maxSegmentMs`.
 * Greedy contiguous fill: a shot joins the current segment while the running
 * total stays within the cap, otherwise it opens a new one. A single shot
 * longer than the cap becomes its own (over-cap) segment — that's the model's
 * problem to enforce, not the tiler's, and silently dropping or splitting it
 * would lose content.
 *
 * Order is preserved (segment identity depends on it); shots are never sorted.
 */
export function tileSceneIntoSegments(
  shots: readonly SegmentShot[],
  maxSegmentMs: number
): TiledSegment[] {
  const cap = maxSegmentMs > 0 ? maxSegmentMs : DEFAULT_SEGMENT_CAP_MS;
  const segments: TiledSegment[] = [];
  let current: TiledSegment | null = null;

  for (const shot of shots) {
    const dur = Math.max(0, shot.durationMs);
    if (current && current.durationMs + dur <= cap) {
      current.shotIds.push(shot.id);
      current.durationMs += dur;
    } else {
      current = { shotIds: [shot.id], durationMs: dur };
      segments.push(current);
    }
  }

  return segments;
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
