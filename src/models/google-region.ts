// Google refuses some caller locations; on that refusal this isolate routes Gemini off Google for an hour. See docs/architecture/media-vias.md → Native Google.

import { ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'ai', 'google-region']);

const GEMINI_REGION_REFUSED_MESSAGE =
  "Gemini isn't available from this region.";

export const GOOGLE_REGION_BLOCK_TTL_MS = 60 * 60 * 1000;

let blockedUntil = 0;

/** Google's wording; a bare 400 is not enough (malformed requests get one too). */
export function isGoogleRegionBlockedMessage(message: string): boolean {
  return /user location is not supported/i.test(message);
}

/** True when `error` or its `cause` chain is the refusal. */
export function isGoogleRegionBlockedError(error: unknown): boolean {
  if (typeof error === 'string') return isGoogleRegionBlockedMessage(error);
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (isGoogleRegionBlockedMessage(e.message)) return true;
  }
  return false;
}

export function isGoogleRegionBlockedHere(now: number = Date.now()): boolean {
  return now < blockedUntil;
}

export function markGoogleRegionBlocked(
  label: string,
  error: unknown,
  now: number = Date.now()
): void {
  const alreadyBlocked = isGoogleRegionBlockedHere(now);
  blockedUntil = now + GOOGLE_REGION_BLOCK_TTL_MS;
  if (alreadyBlocked) return;
  logger.warn(
    `${label}: Google refused this location; routing Gemini off Google for an hour`,
    { event: 'google_region_blocked', operation: label, err: error }
  );
}

export function resetGoogleRegionBlock(): void {
  blockedUntil = 0;
}

/** Whether a refusal earns one re-run (marking the isolate); read `blockedAtStart` before the attempt. */
export function claimGoogleRegionRetry(
  label: string,
  error: unknown,
  blockedAtStart: boolean
): boolean {
  if (blockedAtStart || !isGoogleRegionBlockedError(error)) return false;
  markGoogleRegionBlocked(label, error);
  return true;
}

/** Log a failed re-run with the refusal that caused it, then rethrow it unchanged. */
export function rethrowFailedGoogleRegionRetry(
  label: string,
  refusal: unknown,
  retryError: unknown
): never {
  logger.error(`${label}: re-run after Google's location refusal failed`, {
    event: 'google_region_retry_failed',
    operation: label,
    err: retryError,
    refusal,
  });
  throw retryError;
}

/** Run `run`; on a refusal, mark the isolate and run once more (its resolvers now skip Google). */
export async function withGoogleRegionFallback<T>(
  label: string,
  run: () => Promise<T>
): Promise<T> {
  const blockedAtStart = isGoogleRegionBlockedHere();
  try {
    return await run();
  } catch (error) {
    if (!claimGoogleRegionRetry(label, error, blockedAtStart)) throw error;
    try {
      return await run();
    } catch (retryError) {
      rethrowFailedGoogleRegionRetry(label, error, retryError);
    }
  }
}

/** For Files API calls, which have no other via: a refusal marks the isolate and says so. */
export async function refuseGeminiOffRegion<T>(
  label: string,
  run: () => Promise<T>
): Promise<T> {
  const blockedAtStart = isGoogleRegionBlockedHere();
  try {
    return await run();
  } catch (error) {
    const refused = isGoogleRegionBlockedError(error);
    if (!refused && (blockedAtStart || !isGoogleRegionBlockedHere()))
      throw error;
    if (refused) markGoogleRegionBlocked(label, error);
    throw new ValidationError(GEMINI_REGION_REFUSED_MESSAGE);
  }
}

/** The error for a Files API call with no Google via: a refusal here, else a missing key. */
export function geminiUnavailableError(noKeyMessage: string): ValidationError {
  return new ValidationError(
    isGoogleRegionBlockedHere() ? GEMINI_REGION_REFUSED_MESSAGE : noKeyMessage
  );
}
