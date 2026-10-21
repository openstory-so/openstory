/**
 * At most two `/api/realtime` streams: billing, then everything else.
 * Callers close EventSource and wait out {@link nextClientReconnectDelay}
 * so a dropped isolate does not retry on one shared timer.
 */

import type { ConnectionStatus } from '@/platform/server/realtime/shared-types';

export const REALTIME_RECONNECT_MIN_MS = 1_000;
export const REALTIME_RECONNECT_MAX_MS = 30_000;
/** Match the server ping. Reset backoff only after the socket stays up this long. */
export const REALTIME_STABLE_OPEN_MS = 25_000;
/** Failures with no lasting open before the shared status becomes `error`. */
export const REALTIME_HARD_FAIL_ATTEMPTS = 3;

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

/**
 * `unit` is in `[0, 1]`. The result is half to all of `baseMs`, so tabs that
 * drop together do not wait the same amount and never retry immediately.
 */
export function jitterReconnectDelay(baseMs: number, unit: number): number {
  const clamped = Math.min(1, Math.max(0, unit));
  return Math.round(baseMs * (0.5 + clamped * 0.5));
}

/**
 * Heavy (talent / sequence) drives the shared status. A billing reconnect
 * must not demote a live heavy stream, or the stale-sheet toast sticks.
 */
export function combineRealtimeStatus(
  billing: ConnectionStatus | null,
  heavy: ConnectionStatus | null
): ConnectionStatus {
  if (heavy === 'error' || heavy === 'connected' || heavy === 'connecting') {
    return heavy;
  }
  if (
    billing === 'error' ||
    billing === 'connected' ||
    billing === 'connecting'
  ) {
    return billing;
  }
  return 'disconnected';
}
