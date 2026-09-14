/**
 * Greedy contiguous fill of a scene into ≤cap render units (#990 / #1510).
 *
 * Client-safe: the shot list previews the same membership generate will use.
 * `packMotionBatchShots` is the live server caller; `resolveSegmentCapMs` is
 * the schema-backed cap. The UI uses `durationGridForModel`'s max, which the
 * capabilities lockstep test keeps equal to that schema.
 */

/** Fallback segment cap when a model's duration set is empty. */
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
