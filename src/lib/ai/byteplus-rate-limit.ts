/**
 * BytePlus Ark quota handling (#1157).
 *
 * Ark enforces per-account RPM and concurrency quotas (Seedream defaults to
 * 500 RPM; Seedance concurrency is account-tier dependent and not published).
 * A batch render fans a whole sequence out at once, so quota rejections are
 * expected traffic, not exceptional — they need backoff, not a failure.
 *
 * This is the ONLY backpressure, deliberately. A per-run fan-out cap looks
 * like the obvious partner to it and is not: the cap applies per workflow RUN,
 * so N concurrent sequences multiply straight through it (#1143 measured this
 * and deleted the mechanism — 20 sequences at a cap of 8 is 160 concurrent
 * children). An Ark quota is per ACCOUNT, i.e. precisely the thing a per-run
 * limit cannot see, so pacing each run individually would buy latency without
 * bounding what the quota actually counts. Backoff reacts to the real signal.
 *
 * Two things this must NOT do:
 *   - Consume the content-flag retry budget. A 429 is not a content rejection;
 *     re-rolling the seed wastes an attempt on a request the model never saw.
 *   - Retry a real error. Ark returns 400 for a malformed request and 404
 *     `ModelNotOpen` for a model the account has not activated; both are
 *     permanent and retrying them just delays the report.
 */

import { reportBytePlusQuotaBackoff } from '@/lib/ai/byteplus-observability';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'byteplus-rate-limit']);

/** Attempts (including the first) before a quota rejection becomes an error. */
export const BYTEPLUS_QUOTA_MAX_ATTEMPTS = 5;

/** First backoff step; each subsequent wait doubles. */
const BYTEPLUS_QUOTA_BASE_DELAY_MS = 2_000;

/** Ceiling on one wait, so a long batch cannot stall a workflow step. */
export const BYTEPLUS_QUOTA_MAX_DELAY_MS = 30_000;

/**
 * Ark error codes that mean "you are over quota, try again", as distinct from
 * "this request is wrong". Matched case-insensitively against the dotted code
 * and the message, because Ark surfaces the condition in both places
 * depending on which layer rejected it.
 */
const QUOTA_MARKERS = [
  'ratelimit',
  'rate limit',
  'quotaexceeded',
  'quota exceeded',
  'too many requests',
  'serverovervalue',
  'concurrency',
];

/** True when an error is Ark telling us to slow down rather than stop. */
export function isBytePlusQuotaError(error: unknown): boolean {
  if (error instanceof Error && 'status' in error && error.status === 429) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const haystack = message.toLowerCase();
  return QUOTA_MARKERS.some((marker) => haystack.includes(marker));
}

/** Exponential backoff for attempt `n` (0-indexed), capped. */
export function bytePlusQuotaDelayMs(attempt: number): number {
  return Math.min(
    BYTEPLUS_QUOTA_BASE_DELAY_MS * 2 ** attempt,
    BYTEPLUS_QUOTA_MAX_DELAY_MS
  );
}

/**
 * Run `fn`, retrying only quota rejections with exponential backoff.
 *
 * Everything else propagates on the first throw: a content rejection reaches
 * the caller's re-roll logic untouched, and a permanent error fails fast.
 */
export async function withBytePlusQuotaRetry<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < BYTEPLUS_QUOTA_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isBytePlusQuotaError(error)) throw error;
      lastError = error;
      if (attempt === BYTEPLUS_QUOTA_MAX_ATTEMPTS - 1) {
        // Error, not warn: the caller now sees a failure a user will notice,
        // and a non-zero rate here is the trigger to build real admission
        // control rather than lean on backoff (see the module header).
        logger.error(
          `${label}: Ark quota retry budget exhausted after ${BYTEPLUS_QUOTA_MAX_ATTEMPTS} attempts`,
          { operation: label, attempts: BYTEPLUS_QUOTA_MAX_ATTEMPTS }
        );
        reportBytePlusQuotaBackoff({
          operation: label,
          attempt: attempt + 1,
          exhausted: true,
        });
        break;
      }
      const delay = bytePlusQuotaDelayMs(attempt);
      logger.warn(
        `${label}: Ark quota rejection, retrying in ${delay}ms (attempt ${attempt + 1}/${BYTEPLUS_QUOTA_MAX_ATTEMPTS})`
      );
      reportBytePlusQuotaBackoff({
        operation: label,
        attempt: attempt + 1,
        delayMs: delay,
        exhausted: false,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
