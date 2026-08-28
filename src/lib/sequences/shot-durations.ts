import type { Shot } from '@/lib/db/schema';

/**
 * Sum a sequence's per-shot durations in seconds, falling back to 10s for any
 * shot whose duration is unknown. Shared by the add-audio and generate-music
 * paths; callers apply their own empty-sequence floor (`|| 30`).
 */
export function sumShotDurationsSeconds(
  shots: ReadonlyArray<Pick<Shot, 'durationMs'>>
): number {
  return shots.reduce(
    (sum, shot) => sum + (shot.durationMs ? shot.durationMs / 1000 : 10),
    0
  );
}
