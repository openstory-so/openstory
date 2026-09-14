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
import type { MediaVia } from '@/models/via';
import { workersSafeFetch } from '@/platform/server/ai/workers-safe-fetch';

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

/**
 * Shared AIGC group for every PR preview (#1635). Ark quotas are
 * per-account, so a group per preview did not isolate capacity — it only
 * multiplied groups and orphaned them when the preview Worker/D1 died.
 * All previews therefore share one group. Production's hourly job age-sweeps
 * it; a preview must never run that orphan-delete against this group, or it
 * would wipe another PR's sheets. `BYTEPLUS_ASSET_GROUP_ID` still pins a
 * group by id and skips the name entirely.
 */
export const PREVIEW_AIGC_GROUP_NAME = 'openstory-virtual-preview';

const PREVIEW_PR_GROUP_NAME = /^openstory-virtual-pr-(\d+)(?:-|$)/;

export type AigcGroupScope = 'preview' | 'local' | 'production';

function appHost(): string {
  const appUrl = optionalEnv('VITE_APP_URL');
  if (!appUrl) return 'local';
  try {
    return new URL(appUrl).host;
  } catch {
    return appUrl;
  }
}

export function aigcGroupScope(): AigcGroupScope {
  if (optionalEnv('VITE_IS_PREVIEW') === 'true') return 'preview';
  const host = appHost();
  if (/^pr-\d+\./i.test(host)) return 'preview';
  if (
    host === 'local' ||
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host.startsWith('127.0.0.1:')
  ) {
    return 'local';
  }
  return 'production';
}

/**
 * Legacy per-PR group names (`openstory-virtual-pr-<n>-…`). New previews
 * no longer create these; teardown and the production backstop delete them.
 */
export function isPreviewPrAssetGroupName(
  name: string,
  prNumber?: number
): boolean {
  const match = PREVIEW_PR_GROUP_NAME.exec(name);
  if (!match) return false;
  if (prNumber === undefined) return true;
  return match[1] === String(prNumber);
}

/**
 * The AIGC asset group this deployment owns. Production and local stay
 * per-host (`openstory-virtual-<host>`) so the hourly ledger sweep is
 * 1 group ↔ 1 D1. Previews share {@link PREVIEW_AIGC_GROUP_NAME}.
 */
export function aigcGroupName(): string {
  if (aigcGroupScope() === 'preview') return PREVIEW_AIGC_GROUP_NAME;
  const slug = appHost()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `openstory-virtual-${slug}`.slice(0, 64);
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
