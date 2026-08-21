/**
 * BytePlus Ark (ModelArk) env — the native via for Seedance video and
 * Seedream image (#1157).
 *
 * Claim the via the same way Grok does (#1167): `isNativeBytePlus*Model` at
 * the generation site, then this module only answers "is the platform Ark
 * key live?". Stamp `via` on the job; poll MUST follow the stamp.
 *
 * Platform key only: `API_KEY_PROVIDERS` has no `'byteplus'`. A team on its
 * own fal key stays on fal — routing their Seedance onto our Ark account
 * would bill us for it.
 */

import { getEnv } from '#env';
import type { MediaVia } from '@/lib/ai/via';
import { workersSafeFetch } from '@/lib/ai/workers-safe-fetch';

/**
 * Ark data-plane base URL. The adapter defaults to the Asia-Pacific host;
 * `ARK_BASE_URL` overrides it so e2e can point at aimock. Ark keys are
 * region-isolated and Seedance is served only from `ap-southeast`, so an EU
 * key against the default host fails at request time, not at startup.
 */
function getArkBaseUrl(): string | undefined {
  return getEnv().ARK_BASE_URL || undefined;
}

/** The platform Ark key, or undefined when BytePlus is not configured. */
export function getArkApiKey(): string | undefined {
  return getEnv().ARK_API_KEY || undefined;
}

/**
 * True when the platform can submit to Ark at all.
 *
 * E2E is hermetic by construction: aimock intercepts fal through the
 * `x-fal-target-host` header fal-config stamps, and Ark requests carry no such
 * header. Playwright injects the developer's process env into the worker
 * (`CLOUDFLARE_INCLUDE_PROCESS_ENV`), so an `ARK_API_KEY` sitting in a local
 * `.env.local` would silently point the suite at real, billable BytePlus. Under
 * `E2E_TEST` the via therefore stays off unless `ARK_BASE_URL` is also set —
 * i.e. unless someone has deliberately wired a mock host to record against.
 */
export function isBytePlusConfigured(): boolean {
  if (getArkApiKey() === undefined) return false;
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !env.ARK_BASE_URL) return false;
  return true;
}

/**
 * After xAI has been ruled out, claim BytePlus the way Grok claims xAI:
 * native model + live key, else fal. `usingOwnFalKey` is the extra veto
 * Grok does not need (xAI has team keys; Ark does not).
 */
export function claimBytePlusVia(options: {
  native: boolean;
  usingOwnFalKey: boolean;
}): Extract<MediaVia, 'byteplus' | 'fal'> {
  if (!options.native) return 'fal';
  if (options.usingOwnFalKey) return 'fal';
  return isBytePlusConfigured() ? 'byteplus' : 'fal';
}

/**
 * Shared Ark adapter config. `timeout` becomes an `AbortSignal` inside the
 * fetch-based video/image adapters, so a stalled Ark connection fails the
 * workflow step instead of hanging it (the same guarantee `createDeadlineFetch`
 * gives the fal path).
 */
export function arkAdapterConfig(
  apiKey: string,
  timeoutMs: number
): {
  apiKey: string;
  timeout: number;
  fetch: typeof workersSafeFetch;
  baseURL?: string;
} {
  const baseURL = getArkBaseUrl();
  return {
    apiKey,
    timeout: timeoutMs,
    fetch: workersSafeFetch,
    ...(baseURL && { baseURL }),
  };
}
