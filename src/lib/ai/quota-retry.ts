/**
 * Provider quota handling for BytePlus Ark (#1157) and the LLM providers.
 *
 * Both providers rate-limit the same way and want the same answer, so they
 * share one loop here rather than two copies that drift:
 *
 *   - Ark enforces per-ACCOUNT RPM and concurrency quotas (Seedream defaults
 *     to 500 RPM; Seedance concurrency is account-tier dependent and not
 *     published). A batch render fans a whole sequence out at once, so quota
 *     rejections are expected traffic, not exceptional.
 *   - Motion-prompt (and other) workflows fan a scene out per shot, so a
 *     Gemini/OpenRouter RPM quota 429s the whole batch at once.
 *
 * Backoff is the ONLY backpressure, deliberately. A per-run fan-out cap looks
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
import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'ai', 'quota-retry']);

/** Attempts (including the first) before a quota rejection becomes an error. */
export const QUOTA_MAX_ATTEMPTS = 5;

/** First backoff step; each subsequent wait doubles. */
const QUOTA_BASE_DELAY_MS = 2_000;

/** Ceiling on one wait, so a long batch cannot stall a workflow step. */
export const QUOTA_MAX_DELAY_MS = 30_000;

/**
 * Ark error codes that mean "you are over quota, try again", as distinct from
 * "this request is wrong". Matched case-insensitively against the dotted code
 * and the message, because Ark surfaces the condition in both places
 * depending on which layer rejected it.
 */
const BYTEPLUS_QUOTA_MARKERS = [
  'ratelimit',
  'rate limit',
  'quotaexceeded',
  'quota exceeded',
  'too many requests',
  'serverovervalue',
  'concurrency',
];

const LLM_QUOTA_MARKERS = [
  'resource has been exhausted',
  'resource_exhausted',
  'rate-limited',
  'rate limit',
  'too many requests',
  'quota exceeded',
];

function hasStatus429(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 429;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

/** True when an error is Ark telling us to slow down rather than stop. */
export function isBytePlusQuotaError(error: unknown): boolean {
  if (hasStatus429(error)) return true;
  const haystack = messageOf(error);
  return BYTEPLUS_QUOTA_MARKERS.some((marker) => haystack.includes(marker));
}

/** True when the LLM provider is asking us to slow down rather than stop. */
export function isLlmRateLimitError(error: unknown): boolean {
  if (hasStatus429(error)) return true;
  const haystack = messageOf(error);
  if (
    haystack.includes('"code": 429') ||
    haystack.includes('"code":429') ||
    haystack.includes('code 429')
  ) {
    return true;
  }
  return LLM_QUOTA_MARKERS.some((marker) => haystack.includes(marker));
}

/** Exponential backoff for attempt `n` (0-indexed), capped. */
export function quotaDelayMs(attempt: number): number {
  return Math.min(QUOTA_BASE_DELAY_MS * 2 ** attempt, QUOTA_MAX_DELAY_MS);
}

/**
 * Same curve with ±50% jitter, so parallel children that 429 together don't
 * retry in lockstep. Ark doesn't need this (its quota is per-account, so
 * desynchronising siblings buys nothing); the LLM providers do.
 */
export function jitteredQuotaDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  return Math.round(quotaDelayMs(attempt) * (0.5 + random()));
}

type QuotaRetryPolicy = {
  /** Human name for the provider, used in log lines. */
  provider: string;
  isRetryable: (error: unknown) => boolean;
  delayMs: (attempt: number) => number;
  /** Called on every rejection, including the one that exhausts the budget. */
  onBackoff?: (event: {
    operation: string;
    attempt: number;
    delayMs?: number;
    exhausted: boolean;
  }) => void;
};

/**
 * Run `fn`, retrying only quota rejections with exponential backoff.
 *
 * Everything else propagates on the first throw: a content rejection reaches
 * the caller's re-roll logic untouched, and a permanent error fails fast.
 */
async function withQuotaRetry<T>(
  label: string,
  policy: QuotaRetryPolicy,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < QUOTA_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!policy.isRetryable(error)) throw error;
      lastError = error;
      if (attempt === QUOTA_MAX_ATTEMPTS - 1) {
        // Error, not warn: the caller now sees a failure a user will notice,
        // and a non-zero rate here is the trigger to build real admission
        // control rather than lean on backoff (see the module header).
        logger.error(
          `${label}: ${policy.provider} quota retry budget exhausted after ${QUOTA_MAX_ATTEMPTS} attempts`,
          { operation: label, attempts: QUOTA_MAX_ATTEMPTS }
        );
        policy.onBackoff?.({
          operation: label,
          attempt: attempt + 1,
          exhausted: true,
        });
        break;
      }
      const delay = policy.delayMs(attempt);
      logger.warn(
        `${label}: ${policy.provider} quota rejection, retrying in ${delay}ms (attempt ${attempt + 1}/${QUOTA_MAX_ATTEMPTS})`
      );
      policy.onBackoff?.({
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

export function withBytePlusQuotaRetry<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  return withQuotaRetry(
    label,
    {
      provider: 'Ark',
      isRetryable: isBytePlusQuotaError,
      delayMs: quotaDelayMs,
      onBackoff: reportBytePlusQuotaBackoff,
    },
    fn
  );
}

export function withLlmRateLimitRetry<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  return withQuotaRetry(
    label,
    {
      provider: 'LLM',
      isRetryable: isLlmRateLimitError,
      delayMs: jitteredQuotaDelayMs,
    },
    fn
  );
}
