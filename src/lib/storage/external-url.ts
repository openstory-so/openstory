/**
 * Outbound-URL shim for stored media.
 *
 * Stored media URLs are origin-relative (`/r2/<key>`, see #894) — browsers
 * resolve them against the serving origin, but anything we hand to a REAL
 * external service must be made publicly fetchable first:
 *
 * - With a public CDN domain configured (production / opt-in remote dev):
 *   absolutize against `R2_PUBLIC_STORAGE_DOMAIN` at the moment of use.
 * - Without one (local dev / e2e record, but also CDN-less production
 *   deploy-button workers — this path is load-bearing in real deployments,
 *   not just a dev convenience), there is no public URL at all:
 *   - fal model inputs (Kling `image_url`, nano-banana `image_urls`, …) →
 *     read the bytes from the R2 binding and upload them to fal storage,
 *     substituting the returned fal URL.
 *   - OpenRouter vision messages → inline the bytes as a base64 data part.
 *
 * Pass-through cases:
 * - the URL isn't ours (fal CDN outputs, user-supplied externals, legacy
 *   absolute CDN-domain rows — still fetchable on their original domain), or
 * - we're in e2e REPLAY (aimock string-matches request bodies and never
 *   fetches URLs, so the relative URL can pass through untouched). Record
 *   mode (`E2E_RECORD=1`) talks to real providers and takes the shim path.
 */

import { getEnv } from '#env';
// Deliberately the UPSTREAM client, not the fal-config wrapper: the shim only
// runs when talking to REAL fal (local dev / e2e record), and routing the
// storage upload through FAL_PROXY_URL would just record meaningless
// storage-initiate fixtures in aimock. Model calls still go through the
// proxied clients as usual.
import { createFalClient } from '@fal-ai/client';
import { readStorageObject } from '#storage';
import { sniffImageMimeType } from '@/lib/utils/file';
import { r2KeyFromUrl, toCdnUrl } from './buckets';

function isReplayMode(): boolean {
  const env = getEnv();
  return env.E2E_TEST === 'true' && env.E2E_RECORD !== '1';
}

async function readStoredBytes(
  key: string
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const object = await readStorageObject(key);
  if (!object) {
    throw new Error(`Failed to read storage object ${key}: not found`);
  }
  // Trust the bytes over the stored `contentType`. R2 rows carry whatever the
  // uploader guessed from the source URL's extension, and the upscale path
  // stored PNG bytes as `image/jpeg` — a mislabelled vision part makes
  // Anthropic reject the request (HTTP 400 today; historically an empty
  // completion after a billed reasoning pass, #1218). Both consumers below
  // declare a type downstream (the inline data part, and the `File` handed to
  // fal storage), so correcting it here covers already-stored objects.
  const sniffed = sniffImageMimeType(object.bytes);
  return sniffed && sniffed !== object.contentType
    ? { ...object, contentType: sniffed }
    : object;
}

/**
 * Make a stored media URL fetchable by real fal. CDN-backed deployments
 * absolutize; local `/r2/` URLs are uploaded to fal storage (short-lived
 * scratch space — these are model inputs, not user content); everything else
 * passes through.
 *
 * `falApiKey` credentials the storage client — pass the caller's resolved fal
 * key (BYOK when present) so the upload authenticates on deployments with no
 * platform `FAL_KEY`; falls back to the platform key (#924).
 */
export async function ensureExternallyFetchableUrl(
  url: string,
  falApiKey?: string
): Promise<string> {
  const key = r2KeyFromUrl(url);
  if (key === null) return url;
  const cdnUrl = toCdnUrl(url);
  if (cdnUrl) return cdnUrl;
  if (isReplayMode()) return url;
  const { bytes, contentType } = await readStoredBytes(key);
  const fal = createFalClient({ credentials: falApiKey ?? getEnv().FAL_KEY });
  const filename = key.split('/').pop() || 'upload';
  const file = new File([bytes], filename, { type: contentType });
  return fal.storage.upload(file);
}

export async function ensureExternallyFetchableUrls(
  urls: string[],
  falApiKey?: string
): Promise<string[]> {
  return Promise.all(
    urls.map((url) => ensureExternallyFetchableUrl(url, falApiKey))
  );
}

/**
 * Vision-message image source for a storage URL.
 *
 * Prefer a URL OpenRouter can fetch: CDN absolute in production, fal-storage
 * upload locally / during e2e record (same scratch path as fal model inputs).
 * Not for correctness — a data part works once its declared type matches its
 * bytes (see `readStoredBytes`) — but for payload size: upscaled stills run
 * ~7MB, and inlining one as ~9.3MB of base64 pushed time-to-first-token from
 * ~6s to ~30s per call, which a 14-scene record run pays 14 times over.
 * Replay keeps the relative `/r2/` URL so aimock can string-match. No
 * credentials → last-resort data part.
 */
export async function toVisionImageSource(
  url: string,
  falApiKey?: string
): Promise<
  | { type: 'url'; value: string }
  | { type: 'data'; value: string; mimeType: string }
> {
  const key = r2KeyFromUrl(url);
  if (key === null) return { type: 'url', value: url };
  const cdnUrl = toCdnUrl(url);
  if (cdnUrl) return { type: 'url', value: cdnUrl };
  if (isReplayMode()) return { type: 'url', value: url };

  const creds = falApiKey ?? getEnv().FAL_KEY;
  if (creds) {
    return {
      type: 'url',
      value: await ensureExternallyFetchableUrl(url, falApiKey),
    };
  }

  const { bytes, contentType } = await readStoredBytes(key);
  return {
    type: 'data',
    value: toBase64(bytes),
    mimeType: contentType || 'image/png',
  };
}

// Web-safe base64 (no node:buffer — this module sits on an import path that
// Vite also walks for the client bundle, where node:* is externalized and
// throws at runtime). Chunked to stay under the JS argument-count limit.
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
