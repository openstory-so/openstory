/**
 * Storage buckets — constants, types, and pure functions for R2 storage.
 * Used by both S3 and Cloudflare implementations and by consumers directly.
 */

import { getEnv } from '#env';

export const STORAGE_BUCKETS = {
  THUMBNAILS: 'thumbnails',
  VIDEOS: 'videos',
  AUDIO: 'audio',
  STYLES: 'styles',
  CHARACTERS: 'characters',
  LOCATIONS: 'locations',
  TALENT: 'talent',
  VFX: 'vfx',
  ELEMENTS: 'elements',
} as const;

export type StorageBucket =
  (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

export type UploadResult = {
  path: string;
  publicUrl: string;
  fullPath: string;
};

/**
 * One completed part of a multipart upload. Matches R2's `R2UploadedPart`
 * shape so it can be passed straight to `multipartUpload.complete()`.
 */
export type MultipartPart = {
  partNumber: number;
  etag: string;
};

export type StorageFileInfo = {
  name: string;
  id: string;
  updated_at: string;
  created_at: string;
  last_accessed_at: string;
  metadata: {
    size: number;
    mimetype: string;
    cacheControl: string;
    eTag: string;
  };
};

export function buildR2Key(bucket: StorageBucket, path: string): string {
  return `${bucket}/${path}`;
}

/**
 * Path prefix under which the worker serves storage objects from the R2
 * binding (see `src/routes/r2.$.ts`). Stored media URLs are origin-relative
 * `/r2/<key>` paths (#894): the browser resolves them against whatever origin
 * is serving the page, so deployments need no URL configuration and changing
 * the serving domain never breaks previously generated rows.
 */
const R2_SERVE_PREFIX = '/r2/';

/**
 * True when storage URLs are served by the local /r2 route.
 *
 * E2E always serves locally — the env-file merge under cf-plugin can leak a
 * developer's `.env.local` CDN domain into the test worker, and which layer
 * wins between wrangler `vars`, `.env*`, and process.env has bitten us before
 * (see the E2E_RECORD note in wrangler.jsonc). Gating on E2E_TEST keeps the
 * decision deterministic.
 */
export function isLocalStorageServing(): boolean {
  const env = getEnv();
  if (env.E2E_TEST === 'true') return true;
  return !env.R2_PUBLIC_STORAGE_DOMAIN;
}

/**
 * Origin-relative public URL for a storage object: `/r2/<bucket>/<path>`.
 * This is the canonical form persisted to the database. Consumers that need
 * an absolute URL (external services, Cloudflare image transforms) resolve
 * it at the moment of use — see `r2KeyFromUrl` / `toCdnUrl` and
 * `src/platform/server/storage/external-url.ts`.
 */
export function getPublicUrl(bucket: StorageBucket, path: string): string {
  return `${R2_SERVE_PREFIX}${buildR2Key(bucket, path)}`;
}

/**
 * R2 object key (`<bucket>/<path>`) for a stored media URL, or null when the
 * URL is not one of ours (external URLs, fal CDN outputs, legacy absolute
 * CDN-domain rows). Accepts both the canonical relative form (`/r2/<key>`)
 * and legacy absolute rows that baked an origin in front of the `/r2/` route
 * (`https://<old-app-origin>/r2/<key>`).
 */
export function r2KeyFromUrl(url: string): string | null {
  if (url.startsWith(R2_SERVE_PREFIX)) {
    return url.slice(R2_SERVE_PREFIX.length);
  }
  if (/^https?:\/\//.test(url)) {
    try {
      const pathname = new URL(url).pathname;
      if (pathname.startsWith(R2_SERVE_PREFIX)) {
        return pathname.slice(R2_SERVE_PREFIX.length);
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Absolute URL for a stored media URL on the public CDN domain, or null when
 * no CDN domain is configured (or the URL isn't a stored `/r2/` URL). Use at
 * the moment of handing a URL to something outside the current origin.
 */
export function toCdnUrl(url: string): string | null {
  if (isLocalStorageServing()) return null;
  const key = r2KeyFromUrl(url);
  if (key === null) return null;
  return `https://${getEnv().R2_PUBLIC_STORAGE_DOMAIN}/${key}`;
}

/**
 * Absolute, externally-shareable URL for a stored media URL — for the few
 * egress points that hand a URL to something off the current origin
 * (currently the public API responses; the client-side copy-share-link
 * action in theatre-view inlines the same absolutization because
 * `R2_PUBLIC_STORAGE_DOMAIN` is server-only). Stored rows are
 * origin-relative (#894), which only resolve in-page; this absolutizes them:
 *
 *  - our `/r2/<key>` URLs → the CDN domain when configured, else the given
 *    `origin` (the worker's own `/r2/$` route serves/redirects them, and it
 *    is public — no auth — so the result is genuinely shareable);
 *  - already-absolute URLs (external sources, legacy CDN-domain rows) pass
 *    through unchanged.
 *
 * `origin` is the scheme+host the request arrived on (e.g.
 * `new URL(request.url).origin` server-side, `window.location.origin` in the
 * browser).
 */
export function toShareableUrl(url: string, origin: string): string {
  const cdnUrl = toCdnUrl(url);
  if (cdnUrl) return cdnUrl;
  // Exclude protocol-relative `//host/...` (blocked at ingress by
  // mediaUrlSchema, but pre-#894 rows weren't validated against it): joining
  // it onto the origin would produce a path that isn't what the row meant.
  if (url.startsWith('/') && !url.startsWith('//')) {
    return `${origin.replace(/\/$/, '')}${url}`;
  }
  return url;
}

/**
 * The stored `/r2/<key>` form of a URL `toShareableUrl` handed out (origin or
 * CDN), so a URL an agent read back can be used where a stored one is
 * expected. Anything else comes back unchanged.
 */
export function fromShareableUrl(url: string): string {
  const key = r2KeyFromUrl(url);
  if (key !== null) return `${R2_SERVE_PREFIX}${key}`;
  const domain = getEnv().R2_PUBLIC_STORAGE_DOMAIN;
  const cdn = domain ? `https://${domain}/` : null;
  return cdn && url.startsWith(cdn)
    ? `${R2_SERVE_PREFIX}${url.slice(cdn.length)}`
    : url;
}

export function getPathFromUrl(url: string, bucket: StorageBucket): string {
  const key = r2KeyFromUrl(url);
  const bucketPrefix = `${bucket}/`;
  if (key === null || !key.startsWith(bucketPrefix)) {
    throw new Error(`URL does not match expected bucket format: ${url}`);
  }
  return key.slice(bucketPrefix.length);
}
