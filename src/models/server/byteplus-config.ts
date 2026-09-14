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
 * Resident ACR slots this process will occupy. Unset → 50 (Entry).
 * `0` is valid: do not CreateAsset and do not claim the BytePlus via, so
 * Seedance/Seedream stay on fal. Previews push `BYTEPLUS_ASSET_SLOTS=0`
 * (#1635); set it to 50 (or unset) to opt a preview/local process back onto
 * the shared account pool.
 */
const DEFAULT_BYTEPLUS_ASSET_SLOTS = 50;

export function bytePlusAssetSlots(): number {
  const raw = optionalEnv('BYTEPLUS_ASSET_SLOTS');
  if (raw === undefined) return DEFAULT_BYTEPLUS_ASSET_SLOTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0)
    return DEFAULT_BYTEPLUS_ASSET_SLOTS;
  return parsed;
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
  if (bytePlusAssetSlots() === 0) return false;
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
  if (bytePlusAssetSlots() === 0) return false;
  if (!getBytePlusAccessKey() || !getBytePlusSecretKey()) return false;
  const env = getEnv();
  if (env.E2E_TEST === 'true' && !getBytePlusOpenApiHost()) return false;
  return true;
}

/**
 * Per-PR preview groups are `openstory-virtual-pr-<n>-…` (#1635). The
 * group is 1:1 with that preview's D1 ledger (FIFO/LRU eviction, hourly
 * orphan sweep). Teardown deletes the group; production's backstop deletes
 * any whose PR is no longer open. `BYTEPLUS_ASSET_GROUP_ID` still pins a
 * group by id and skips the name entirely.
 */
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

export function previewPrNumberFromGroupName(name: string): number | undefined {
  const match = PREVIEW_PR_GROUP_NAME.exec(name);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function isPreviewPrAssetGroupName(
  name: string,
  prNumber?: number
): boolean {
  const parsed = previewPrNumberFromGroupName(name);
  if (parsed === undefined) return false;
  if (prNumber === undefined) return true;
  return parsed === prNumber;
}

/**
 * The AIGC asset group this deployment owns, `openstory-virtual-<host>`.
 * Production, local, and each preview keep their own group so the D1
 * ledger sweep and LRU eviction stay 1 group ↔ 1 D1.
 */
export function aigcGroupName(): string {
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
