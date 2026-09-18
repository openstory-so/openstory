/**
 * Contiguous partition of a scene into render units (#990 / #1510).
 *
 * Client-safe: the shot list previews the same membership generate will use.
 * `packMotionBatchShots` is the live server caller; `resolveSegmentCapMs` /
 * `resolveSegmentMinMs` are the schema-backed bounds. The UI uses
 * `durationGridForModel`'s min/max, which the capabilities lockstep test
 * keeps equal to that schema.
 *
 * Group only as many shots as needed to meet the model floor (#1658).
 * The tiler optimises over cut positions: minimise under-floor leftovers,
 * then maximise job count (minimise merged shot boundaries). Without a
 * minimum, every shot renders independently.
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
  /**
   * Sum is under the model floor. Generate snaps this clip up to min (or the
   * leftover dropdown routes it to Grok). Omitted when the segment meets min.
   */
  belowMin?: true;
};

type Cut = {
  leftover: number;
  jobs: number;
  prev: number;
};

/**
 * Tile an ordered list of shots into contiguous segments.
 *
 * Each multi-shot segment stays ≤ `maxSegmentMs`. A single shot longer than
 * the cap becomes its own (over-cap) segment — that's the model's problem to
 * enforce, not the tiler's, and silently dropping or splitting it would lose
 * content. When `minSegmentMs` is set, a segment whose sum is under that
 * floor is marked `belowMin` and the cut set minimises how many of those
 * leftovers exist, then maximises job count. Ties favour smaller earlier
 * groups, absorbing a short tail only when needed to avoid a leftover.
 *
 * Order is preserved (segment identity depends on it); shots are never sorted.
 */
export function tileSceneIntoSegments(
  shots: readonly SegmentShot[],
  maxSegmentMs: number,
  minSegmentMs = 0
): TiledSegment[] {
  if (shots.length === 0) return [];

  const cap = maxSegmentMs > 0 ? maxSegmentMs : DEFAULT_SEGMENT_CAP_MS;
  const minMs = minSegmentMs > 0 ? minSegmentMs : 0;
  const n = shots.length;
  const prefix = Array.from({ length: n + 1 }, () => 0);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = (prefix[i] ?? 0) + Math.max(0, shots[i]?.durationMs ?? 0);
  }

  const best: Cut[] = Array.from({ length: n + 1 }, () => ({
    leftover: Number.POSITIVE_INFINITY,
    jobs: Number.NEGATIVE_INFINITY,
    prev: -1,
  }));
  best[0] = { leftover: 0, jobs: 0, prev: -1 };

  for (let j = 1; j <= n; j++) {
    for (let i = 0; i < j; i++) {
      const sum = (prefix[j] ?? 0) - (prefix[i] ?? 0);
      const count = j - i;
      if (count > 1 && sum > cap) continue;
      const prev = best[i];
      if (!prev) continue;
      const belowMin = minMs > 0 && sum < minMs;
      const leftover = prev.leftover + (belowMin ? 1 : 0);
      const jobs = prev.jobs + 1;
      const current = best[j];
      if (!current) continue;
      const betterLeftover = leftover < current.leftover;
      const betterJobs = leftover === current.leftover && jobs > current.jobs;
      // Smaller i leaves earlier groups small and absorbs any tail into
      // the last group: 19×1s / H3 lands on [5][5][9].
      const betterTie =
        leftover === current.leftover &&
        jobs === current.jobs &&
        i < current.prev;
      if (betterLeftover || betterJobs || betterTie) {
        best[j] = { leftover, jobs, prev: i };
      }
    }
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let j = n;
  while (j > 0) {
    const cut = best[j];
    const i = cut?.prev ?? -1;
    if (i < 0) break;
    ranges.push({ start: i, end: j });
    j = i;
  }
  ranges.reverse();

  return ranges.map(({ start, end }) => {
    const shotIds: string[] = [];
    for (let i = start; i < end; i++) {
      const shot = shots[i];
      if (shot) shotIds.push(shot.id);
    }
    const durationMs = (prefix[end] ?? 0) - (prefix[start] ?? 0);
    const belowMin = minMs > 0 && durationMs < minMs;
    return belowMin
      ? { shotIds, durationMs, belowMin: true as const }
      : { shotIds, durationMs };
  });
}
