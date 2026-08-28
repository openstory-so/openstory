/**
 * SSRF-hardened fetch for caller-supplied image URLs (public API element
 * ingestion). An authenticated API caller is still untrusted for the purpose of
 * what *our* server will fetch, so before fetching we:
 *   - allow only http/https,
 *   - block loopback / private / link-local / reserved IP literals and ambiguous
 *     numeric (decimal/hex/octal) or IPv6 host encodings, plus internal-looking
 *     hostnames (localhost, *.internal, *.local),
 *   - follow a bounded number of redirects, re-checking `assertSafeImageUrl` on
 *     every hop so a public URL can't bounce to an internal one,
 *   - abort after {@link IMAGE_FETCH_TIMEOUT_MS} so a black-holing host cannot
 *     hang the request until the isolate dies,
 *   - require a real image Content-Type from the *response* (not the URL ext),
 *   - cap the response size.
 *
 * Runtime note: this runs on Cloudflare Workers, which has no DNS API, so we
 * can't pin the resolved address — DNS-rebinding is the residual gap. In
 * practice Workers egress through Cloudflare's network (no VPC / no instance
 * metadata endpoint reachable), which blunts the classic cloud-metadata target;
 * the host checks below close the direct-literal and internal-name vectors.
 * Fetch failures name the caller-supplied URL (they already know it) and never
 * the blocked redirect target.
 */

import { uploadFile } from '#storage';
import { generateId } from '@/lib/db/id';
import { ValidationError } from '@/lib/errors';
import { getPublicUrl, type StorageBucket } from '@/lib/storage/buckets';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

/** Wall-clock budget for one image fetch, including redirect hops. */
export const IMAGE_FETCH_TIMEOUT_MS = 15_000;

/** Max 3xx hops; each hop is re-checked by {@link assertSafeImageUrl}. */
export const MAX_IMAGE_REDIRECTS = 3;

const DEFAULT_IMAGE_LABEL = 'Element image';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** content-type → file extension for the storage key. */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = Reflect.get(error, 'name');
  return name === 'TimeoutError' || name === 'AbortError';
}

function fetchFailed(
  label: string,
  originalUrl: string,
  reason?: 'timeout' | 'redirect blocked'
): ValidationError {
  const suffix = reason ? ` (${reason})` : '';
  return new ValidationError(
    `${label} could not be fetched${suffix}: ${originalUrl}`
  );
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return true; // malformed → reject
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // multicast / reserved
  );
}

/**
 * Reject host forms that are IP literals (other than verified-public dotted
 * IPv4), ambiguous numeric encodings, IPv6, or internal-looking names. Returns
 * the validated URL.
 */
export function assertSafeImageUrl(
  rawUrl: string,
  label: string = DEFAULT_IMAGE_LABEL
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError(`${label} URL is invalid.`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError(`${label} URL must use http or https.`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Internal-looking names.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new ValidationError(`${label} URL is not allowed.`);
  }

  // IPv6 literal (contains a colon) — uncommon for hosted images; reject to
  // avoid ::1 / fc00::/7 / fe80::/10 / ::ffff:v4 mapping bypasses.
  if (host.includes(':')) {
    throw new ValidationError(`${label} URL is not allowed.`);
  }

  // Ambiguous numeric encodings (decimal 2130706433, hex 0x7f000001, octal):
  // these are almost always SSRF probes for hosted-image use, so reject.
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) {
    throw new ValidationError(`${label} URL is not allowed.`);
  }

  // Dotted IPv4 literal in a private/reserved range.
  if (isPrivateIpv4(host)) {
    throw new ValidationError(`${label} URL is not allowed.`);
  }

  return url;
}

/**
 * Fetch a caller-supplied image URL safely. Validates the host, follows a
 * bounded number of redirects to hosts that still pass {@link assertSafeImageUrl},
 * enforces an image Content-Type from the response, and caps size.
 * Returns the bytes, the validated content type, and its file extension.
 */
async function fetchSafeImage(
  rawUrl: string,
  label: string = DEFAULT_IMAGE_LABEL
): Promise<{ bytes: Uint8Array; contentType: string; extension: string }> {
  let current = rawUrl;

  for (let hops = 0; hops <= MAX_IMAGE_REDIRECTS; hops++) {
    let url: URL;
    try {
      url = assertSafeImageUrl(current, label);
    } catch (error) {
      if (hops > 0) {
        throw fetchFailed(label, rawUrl, 'redirect blocked');
      }
      throw error;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw fetchFailed(
        label,
        rawUrl,
        isTimeoutError(error) ? 'timeout' : undefined
      );
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      void res.body?.cancel();
      if (!location) throw fetchFailed(label, rawUrl);
      try {
        current = new URL(location, url).toString();
      } catch {
        throw fetchFailed(label, rawUrl);
      }
      continue;
    }

    if (!res.ok) {
      throw fetchFailed(label, rawUrl);
    }

    const contentType =
      (res.headers.get('content-type') ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase() ?? '';
    const extension = ALLOWED_IMAGE_TYPES[contentType];
    if (!extension) {
      throw new ValidationError(
        `${label} must be a PNG, JPEG, WebP, GIF, or AVIF.`
      );
    }

    const declaredLength = Number(res.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new ValidationError(`${label} is too large (max 20 MB).`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ValidationError(`${label} is too large (max 20 MB).`);
    }

    return { bytes, contentType, extension };
  }

  throw fetchFailed(label, rawUrl, 'redirect blocked');
}

export type IngestedImage = {
  /** Bucket-relative temp path, e.g. `<teamId>/temp/<id>.png`. */
  tempPath: string;
  /** Public URL of the uploaded temp object. */
  publicUrl: string;
  extension: string;
  contentType: string;
};

export type ImageFetchSource = {
  /** e.g. `Character "Ada" reference image #2`. */
  label: string;
};

/**
 * SSRF-safely fetch a caller-supplied image URL and store it under the given
 * bucket's `temp/` prefix, returning the temp path + public URL. The temp
 * object is later promoted to permanent storage by the relevant create flow
 * (elements → `promoteTempElements`; talent/locations → their create cores).
 */
export async function ingestImageToTempBucket(
  url: string,
  bucket: StorageBucket,
  teamId: string,
  source?: ImageFetchSource
): Promise<IngestedImage> {
  const { bytes, contentType, extension } = await fetchSafeImage(
    url,
    source?.label ?? DEFAULT_IMAGE_LABEL
  );
  const tempPath = `${teamId}/temp/${generateId()}.${extension}`;
  await uploadFile(bucket, tempPath, bytes, { contentType });
  return {
    tempPath,
    publicUrl: getPublicUrl(bucket, tempPath),
    extension,
    contentType,
  };
}
