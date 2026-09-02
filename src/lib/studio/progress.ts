/**
 * Guessed completion for an in-flight studio generation (#1455).
 *
 * Nothing upstream reports progress, so this is a half-life curve from the
 * row's creation: 50% at one half-life, 75% at two, and so on, capped at 99
 * until the row actually completes. Fast at first, then a crawl — the shape
 * users read as "still working" rather than "stuck".
 */

// ponytail: one half-life per activity; swap for per-model observed medians
// once generations record how long they took.
const HALF_LIFE_MS = { image: 5_000, video: 40_000 } as const;

export function estimateStudioProgress(
  activity: 'image' | 'video',
  createdAt: Date,
  now: number
): number {
  const elapsed = Math.max(0, now - createdAt.getTime());
  const fraction = 1 - 0.5 ** (elapsed / HALF_LIFE_MS[activity]);
  return Math.min(99, Math.floor(fraction * 100));
}
