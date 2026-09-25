/**
 * Client session shape for `/api/realtime` (#1792).
 *
 * Billing stays on its own EventSource so a talent-library or sequence
 * payload cannot fill the same Worker write queue. Two streams stay under
 * the browser's 6-connection-per-origin cap (#827).
 *
 * EventSource's built-in retry is a fixed ~3s. A Worker that closes under
 * memory pressure then gets a reconnect storm. Callers close the source and
 * wait {@link nextClientReconnectDelay} instead.
 */

export const REALTIME_RECONNECT_MIN_MS = 1_000;
export const REALTIME_RECONNECT_MAX_MS = 30_000;

function isBillingChannel(channel: string): boolean {
  return channel.startsWith('billing:');
}

export function partitionRealtimeChannels(channels: readonly string[]): {
  billing: string[];
  heavy: string[];
} {
  const billing: string[] = [];
  const heavy: string[] = [];
  for (const channel of channels) {
    if (isBillingChannel(channel)) billing.push(channel);
    else heavy.push(channel);
  }
  return { billing, heavy };
}

/** `attempt` is how many failures have already happened (0 = first retry). */
export function nextClientReconnectDelay(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0)
    return REALTIME_RECONNECT_MIN_MS;
  const shifted =
    attempt >= 16
      ? REALTIME_RECONNECT_MAX_MS
      : REALTIME_RECONNECT_MIN_MS * 2 ** attempt;
  return Math.min(shifted, REALTIME_RECONNECT_MAX_MS);
}
