/**
 * Channel history is the whole lifetime of a sequence, not one run.
 * Replaying a previous run's terminal event while a Continue is already
 * `processing` marks the chip complete before the new `phase:start`
 * exists, and the chip never comes back (#1641).
 *
 * Only a *trailing* terminal is dropped: a `complete` that is followed
 * by the current run's `phase:start` must stay, so a refresh mid-Continue
 * still rebuilds from the earlier run then the new one.
 */
const TRAILING_TERMINAL_EVENTS = new Set([
  'generation.complete',
  'generation.failed',
  'generation.reservation:short',
]);

export function dropTrailingTerminalHistory<T extends { event: string }>(
  events: T[]
): T[] {
  let end = events.length;
  while (end > 0) {
    const last = events[end - 1];
    if (!last || !TRAILING_TERMINAL_EVENTS.has(last.event)) break;
    end -= 1;
  }
  return end === events.length ? events : events.slice(0, end);
}
