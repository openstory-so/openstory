/**
 * Channel history is the whole lifetime of a sequence, not one run.
 * Terminal events close a *prior* run. Replaying them while the sequence
 * is `processing` marks the chip complete; it unmounts, then the new
 * `phase:start` brings it back — appear / disappear / appear (#1641).
 *
 * Live `generation.complete` still arrives over SSE. History only has to
 * rebuild in-flight phases, so every terminal is dropped.
 */
const TERMINAL_HISTORY_EVENTS = new Set([
  'generation.complete',
  'generation.failed',
  'generation.reservation:short',
]);

export function replayableHistoryWhileProcessing<T extends { event: string }>(
  events: T[]
): T[] {
  const kept = events.filter((e) => !TERMINAL_HISTORY_EVENTS.has(e.event));
  return kept.length === events.length ? events : kept;
}
