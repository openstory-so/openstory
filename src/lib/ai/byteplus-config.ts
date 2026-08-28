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

function optionalEnv(name: string): string | undefined {
  const value = Reflect.get(getEnv(), name);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The platform Ark key, or undefined when BytePlus is not configured. */
export function getArkApiKey(): string | undefined {
  return optionalEnv('ARK_API_KEY');
}

/**
 * IAM AK/SK for the Ark control plane (Assets API). Distinct from
 * `ARK_API_KEY` — CreateAsset rejects Bearer tokens.
 */
function getBytePlusAccessKey(): string | undefined {
  return optionalEnv('BYTEPLUS_ACCESS_KEY');
}

function getBytePlusSecretKey(): string | undefined {
  return optionalEnv('BYTEPLUS_SECRET_KEY');
}

function getBytePlusAssetGroupId(): string | undefined {
  return optionalEnv('BYTEPLUS_ASSET_GROUP_ID');
}

function getArkBaseUrl(): string | undefined {
  return optionalEnv('ARK_BASE_URL');
}

function getBytePlusOpenApiHost(): string | undefined {
  return optionalEnv('BYTEPLUS_OPENAPI_HOST');
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
  if (env.E2E_TEST === 'true' && !getArkBaseUrl()) return false;
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
 * True when we can call CreateAsset. Same e2e hermetic rule as the data
 * plane: Playwright injects `.env.local`, so a laptop IAM key would hit
 * real BytePlus unless a mock host is wired.
 */
export function isBytePlusAssetsConfigured(): boolean {
  if (!getBytePlusAccessKey() || !getBytePlusSecretKey()) return false;
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !getBytePlusOpenApiHost()) return false;
  return true;
}

export function bytePlusOpenApiConfig():
  | {
      accessKey: string;
      secretKey: string;
      host?: string;
      groupId?: string;
    }
  | undefined {
  const accessKey = getBytePlusAccessKey();
  const secretKey = getBytePlusSecretKey();
  if (!accessKey || !secretKey || !isBytePlusAssetsConfigured()) {
    return undefined;
  }
  const host = getBytePlusOpenApiHost();
  const groupId = getBytePlusAssetGroupId();
  return {
    accessKey,
    secretKey,
    ...(host && { host }),
    ...(groupId && { groupId }),
  };
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

/**
 * Lazy-load the Ark adapters. A static import of `@tanstack/ai-byteplus`
 * from motion/image/studio generation is pulled in at Worker startup via
 * the workflow graph in `src/server.ts` and was enough, stacked on Grok,
 * to fail preview deploy with "Script startup exceeded CPU time limit".
 */
export async function loadBytePlusVideo() {
  const { createBytePlusVideo } = await import('@tanstack/ai-byteplus');
  return createBytePlusVideo;
}

export async function loadBytePlusImage() {
  const { createBytePlusImage } = await import('@tanstack/ai-byteplus');
  return createBytePlusImage;
}
