/**
 * LLM provider quota handling.
 *
 * Motion-prompt (and other) workflows fan a scene out per shot, so a Gemini
 * (or OpenRouter) RPM/concurrency quota 429s the whole batch at once. Same
 * shape as Ark (#1157): backoff is the backpressure, not a per-run fan-out
 * cap. Jitter desynchronises siblings that all 429'd on the same tick.
 */

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'llm-rate-limit']);

/** Attempts (including the first) before a 429 becomes an error. */
export const LLM_RATE_LIMIT_MAX_ATTEMPTS = 5;

/** First backoff step; each subsequent wait doubles. */
const LLM_RATE_LIMIT_BASE_DELAY_MS = 2_000;

/** Ceiling on one wait, so a long batch cannot stall a workflow step. */
export const LLM_RATE_LIMIT_MAX_DELAY_MS = 30_000;

const RATE_LIMIT_MARKERS = [
  'resource has been exhausted',
  'resource_exhausted',
  'rate-limited',
  'rate limit',
  'too many requests',
  'quota exceeded',
];

/** True when the provider is asking us to slow down rather than stop. */
export function isLlmRateLimitError(error: unknown): boolean {
  if (error instanceof Error && 'status' in error && error.status === 429) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const haystack = message.toLowerCase();
  if (
    haystack.includes('"code": 429') ||
    haystack.includes('"code":429') ||
    haystack.includes('code 429')
  ) {
    return true;
  }
  return RATE_LIMIT_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Exponential backoff for attempt `n` (0-indexed), capped, with ±50% jitter
 * so parallel children that 429 together don't retry in lockstep.
 */
export function llmRateLimitDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const base = Math.min(
    LLM_RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt,
    LLM_RATE_LIMIT_MAX_DELAY_MS
  );
  return Math.round(base * (0.5 + random()));
}

/**
 * Run `fn`, retrying only rate-limit rejections with exponential backoff.
 * Everything else propagates on the first throw.
 */
export async function withLlmRateLimitRetry<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < LLM_RATE_LIMIT_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isLlmRateLimitError(error)) throw error;
      lastError = error;
      if (attempt === LLM_RATE_LIMIT_MAX_ATTEMPTS - 1) {
        logger.error(
          `${label}: LLM rate-limit retry budget exhausted after ${LLM_RATE_LIMIT_MAX_ATTEMPTS} attempts`,
          { operation: label, attempts: LLM_RATE_LIMIT_MAX_ATTEMPTS }
        );
        break;
      }
      const delay = llmRateLimitDelayMs(attempt);
      logger.warn(
        `${label}: LLM 429, retrying in ${delay}ms (attempt ${attempt + 1}/${LLM_RATE_LIMIT_MAX_ATTEMPTS})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
