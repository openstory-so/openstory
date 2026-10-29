/**
 * Google geo-block policy — the via twin of the Anthropic model swap in
 * `region-policy.ts` (#1259).
 *
 * The Gemini API is not offered in every country, and it judges the CALLER's
 * address: a request from one it is not offered in is refused outright with
 * `400 FAILED_PRECONDITION: User location is not supported for the API use.`
 * Our native Google via runs in the Cloudflare colo nearest the user,
 * Workflows included, so a user in Hong Kong is refused from "server-side"
 * code too — every Nano Banana still of a paid sequence, 19 times in a row,
 * on 2026-10-28.
 *
 * Every Gemini model we route natively also exists on the no-key via (text on
 * OpenRouter, Nano Banana and Omni Flash on fal), served from where Google is
 * not. So the remedy is a via swap, not a model swap: on the refusal, remember
 * that Google is unreachable from this isolate and run the call again exactly
 * as a deployment with no Google key would have. The key resolvers consult the
 * memo, so the second attempt — and every later call in this isolate — picks
 * the fallback via before anything is sent. An isolate lives in one colo, so
 * the memo is right for as long as it lives; it expires after an hour so a
 * region Google starts serving is picked up without a redeploy.
 *
 * This is not the provider hop AGENTS.md forbids: the refusal comes back
 * before Google starts a job, with no spend, no job id and no via stamp, so
 * there is nothing on Google's side to poll or to bill. A job that WAS stamped
 * `google` is still polled on Google (`resolveGoogleKeyForStampedJob`).
 */

import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'ai', 'google-region']);

/**
 * For the two features only Gemini's Files API can serve (watching a clip,
 * checking a clip for a real person): there is no via to fall back to.
 */
export const GEMINI_REGION_REFUSED_MESSAGE =
  "Google's Gemini API does not serve requests from this region, and this needs Gemini. Try again from another network or location.";

/** How long one refusal keeps this isolate off the native Google via. */
export const GOOGLE_REGION_BLOCK_TTL_MS = 60 * 60 * 1000;

let blockedUntil = 0;

/**
 * Google's own wording for the refusal, as `@google/genai` surfaces it
 * (`BadRequestError: 400 User location is not supported for the API use.`)
 * and as our stream wrapper reports it (`LLM stream error [...]: 400 User
 * location is not supported for the API use.`). A status alone is not
 * enough — Gemini answers 400 to a malformed request too.
 */
export function isGoogleRegionBlockedMessage(message: string): boolean {
  return /user location is not supported/i.test(message);
}

/** True when `error`, or anything in its `cause` chain, is the refusal. */
export function isGoogleRegionBlockedError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth++) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === 'string'
          ? current
          : '';
    if (isGoogleRegionBlockedMessage(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** Whether a new call from this isolate should skip the native Google via. */
export function isGoogleRegionBlockedHere(now: number = Date.now()): boolean {
  return now < blockedUntil;
}

/**
 * Record that Google refused this isolate's location. `label` names the call
 * that learnt it, for the log line.
 */
export function markGoogleRegionBlocked(
  label: string,
  error?: unknown,
  now: number = Date.now()
): void {
  const alreadyBlocked = isGoogleRegionBlockedHere(now);
  blockedUntil = now + GOOGLE_REGION_BLOCK_TTL_MS;
  if (alreadyBlocked) return;
  logger.warn(
    `${label}: Google refused this location; routing Gemini models to their non-Google via for the next hour`,
    { event: 'google_region_blocked', operation: label, err: error }
  );
}

/** Forget a recorded refusal — for tests. */
export function resetGoogleRegionBlock(): void {
  blockedUntil = 0;
}

/**
 * Run a call that may go out on the native Google via. If Google refuses the
 * location, remember it and run the call once more: `run` chooses its via
 * fresh each time (through a resolver that consults the memo), so the second
 * attempt lands on fal or OpenRouter. Any other error, and a refusal from an
 * isolate already marked blocked (the call did not go through a resolver that
 * consults the memo), rethrows untouched.
 */
export async function withGoogleRegionFallback<T>(
  label: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isGoogleRegionBlockedError(error) || isGoogleRegionBlockedHere()) {
      throw error;
    }
    markGoogleRegionBlocked(label, error);
    return run();
  }
}
