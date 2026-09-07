/**
 * BytePlus request governor — one token bucket per BytePlus account, held in
 * a single Durable Object so it can see the whole system (#1519).
 *
 * The Assets OpenAPI quotas (`AccountFlowLimitExceeded`, `QuotaWriteQPMExceeded`)
 * are per ACCOUNT, shared by every team and every preview. A workflow run
 * only sees itself, so any limiter inside a run cannot hold the account
 * under quota — that is why #1143 deleted the per-run fan-out cap. This DO is
 * the one place every call passes through before it fires; callers ask for a
 * token and get back how long to wait.
 *
 * State is in memory on purpose: a DO is single-threaded, and after an
 * eviction the bucket simply restarts full, which is a one-off burst of at
 * most `capacity` requests. Backoff retry stays underneath as the backstop
 * for that and for whatever BytePlus throttles that we did not model.
 */

import { DurableObject } from 'cloudflare:workers';

type Bucket = { tokens: number; lastRefillAt: number };

export type AcquireInput = {
  /** Bucket id — the BytePlus account (hashed access key). */
  bucket: string;
  /** Max burst. */
  capacity: number;
  /** Sustained rate. */
  refillPerMinute: number;
  /**
   * Longest delay the caller will sleep. A reservation beyond it is refused
   * (nothing is taken from the bucket) and `acquire` returns -1, so a queue
   * that would outlive the workflow step fails fast instead of hanging.
   */
  maxWaitMs: number;
};

export class BytePlusGovernor extends DurableObject {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Reserve one token. Returns the delay in ms the caller must sleep before
   * sending — 0 when a token is free now, -1 when the wait would exceed
   * `maxWaitMs` (then nothing was reserved). Tokens are reserved in the order
   * calls arrive, so a burst of N callers gets N ascending delays rather than
   * all retrying together.
   */
  acquire(input: AcquireInput, now = Date.now()): number {
    const capacity = Math.max(1, input.capacity);
    const refillPerMs = Math.max(input.refillPerMinute, 1) / 60_000;
    const bucket = this.buckets.get(input.bucket) ?? {
      tokens: capacity,
      lastRefillAt: now,
    };
    const refilled = Math.min(
      capacity,
      bucket.tokens + (now - bucket.lastRefillAt) * refillPerMs
    );
    // Going negative is the reservation: the caller who takes the bucket to
    // -k owes the k-th refill interval.
    const tokens = refilled - 1;
    const delayMs = tokens >= 0 ? 0 : Math.ceil(-tokens / refillPerMs);
    if (delayMs > input.maxWaitMs) {
      // Refused: persist only the refill, not the reservation.
      this.buckets.set(input.bucket, { tokens: refilled, lastRefillAt: now });
      return -1;
    }
    this.buckets.set(input.bucket, { tokens, lastRefillAt: now });
    return delayMs;
  }
}
