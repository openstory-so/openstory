/**
 * Observability for BytePlus Ark quota pressure (#1157).
 *
 * Backoff is the platform's ONLY backpressure against Ark's per-account
 * quotas (see `byteplus-rate-limit.ts` for why a per-run fan-out cap is not
 * the answer). That makes its firing rate the one signal telling us whether
 * the choice is holding — and without it, "never fires" and "fires on every
 * batch" look identical from a dashboard.
 *
 * That indistinguishability is the failure mode #1143 named when it deleted
 * the old fan-out ceiling: the cap measured nothing, so nobody could tell it
 * was buying latency for no benefit. Emitting here is what keeps the decision
 * to rely on backoff falsifiable rather than a standing assumption.
 *
 * Read it as two questions:
 *   - `exhausted: false` rate → are we approaching the quota at all?
 *   - `exhausted: true` rate → is a user seeing a failed shot because of it?
 *
 * A non-zero exhaustion rate is the trigger to build real admission control
 * (a bounded queue in front of Ark, which unlike a per-run cap can see the
 * whole system). Until then this stays report-only.
 */

import { getLogger } from '@/lib/observability/logger';
import { getPostHogClient } from '@/lib/posthog-server';

const logger = getLogger(['openstory', 'ai', 'byteplus']);

export type BytePlusQuotaBackoffContext = {
  /** Which call hit the quota — e.g. `motion submit`, `image generate`. */
  operation: string;
  /** 1-based attempt that was rejected. */
  attempt: number;
  /** Wait before the next attempt; absent when the budget is exhausted. */
  delayMs?: number;
  /** True when the retry budget ran out and the caller sees the failure. */
  exhausted: boolean;
};

const BYTEPLUS_QUOTA_BACKOFF_EVENT = 'byteplus_quota_backoff';

/**
 * Emit one event per quota rejection, including the final exhausting one.
 *
 * Deliberately un-deduped: a quota problem IS a rate, so collapsing repeats
 * would erase the measurement this exists to take.
 */
export function reportBytePlusQuotaBackoff(
  ctx: BytePlusQuotaBackoffContext
): void {
  const posthog = getPostHogClient();
  posthog?.capture({
    distinctId: 'system',
    event: BYTEPLUS_QUOTA_BACKOFF_EVENT,
    properties: {
      operation: ctx.operation,
      attempt: ctx.attempt,
      ...(ctx.delayMs !== undefined && { delay_ms: ctx.delayMs }),
      exhausted: ctx.exhausted,
    },
  });
}

const BYTEPLUS_PORTRAIT_FILTER_FALLBACK_EVENT =
  'byteplus_portrait_filter_fallback';

/**
 * Ark refused a photorealistic still (`PrivacyInformation`) and we resubmitted
 * on fal. Un-deduped: this is how often native Seedance is unusable for the
 * product's actual shots (people), and the signal that the Assets API
 * (`asset://`) is worth building.
 */
export function reportBytePlusPortraitFilterFallback(operation: string): void {
  logger.warn(`Ark portrait filter; falling back to fal (${operation})`);
  const posthog = getPostHogClient();
  posthog?.capture({
    distinctId: 'system',
    event: BYTEPLUS_PORTRAIT_FILTER_FALLBACK_EVENT,
    properties: { operation },
  });
}
