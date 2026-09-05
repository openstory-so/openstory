import { getLogger } from '@/shared/observability/logger';
import { isLocalStorageServing, toCdnUrl } from '@/lib/storage/buckets';

const logger = getLogger(['openstory', 'image', 'image-compress']);
/**
 * Image Compression via Cloudflare Image Resizing
 *
 * Instead of downloading and re-encoding images in-process (which OOMs on
 * Workers for 18-20MB images), returns a `/cdn-cgi/image/` transform URL.
 * Cloudflare resizes at the edge when the downstream service (e.g. Kling)
 * fetches the URL. Zero application memory used.
 *
 * Requires Image Resizing enabled on the Cloudflare zone serving the R2
 * public domain (dashboard → Speed → Optimization → Image Resizing).
 */

export type CompressionResult = {
  url: string;
  originalSizeBytes: number;
};

/**
 * Ensure an image is under the given byte limit using Cloudflare Image Resizing.
 * Returns null if the image is already under the limit.
 * Returns a cdn-cgi/image/ transform URL if compression is needed.
 */
export async function ensureImageUnderLimit(
  imageUrl: string,
  maxBytes: number
): Promise<CompressionResult | null> {
  // Stored URLs are origin-relative (#894) — absolutize against the CDN
  // domain. No CDN domain (local dev / e2e) means no Cloudflare edge in
  // front of storage, so /cdn-cgi/image/ transform URLs wouldn't resolve.
  // Skip compression and let the oversize image through — rare in dev, and
  // better than a guaranteed 404.
  const cdnUrl = toCdnUrl(imageUrl);
  const absoluteUrl =
    cdnUrl ?? (/^https?:\/\//.test(imageUrl) ? imageUrl : null);
  if (isLocalStorageServing()) {
    // Fires regardless of image size (the size check below needs an
    // absolute URL to HEAD) — "unavailable", not "image was oversize".
    logger.warn(
      `Image compression unavailable for ${imageUrl} — local storage serving has no Image Resizing edge; passing the original through`
    );
    return null;
  }
  if (!absoluteUrl) {
    logger.warn(
      `Image compression unavailable for ${imageUrl} — relative non-/r2/ URL cannot be absolutized for the transform edge; passing the original through`
    );
    return null;
  }

  // HEAD check — skip transform if already under limit
  const headResponse = await fetch(absoluteUrl, { method: 'HEAD' });
  const contentLength = headResponse.headers.get('content-length');

  if (contentLength && Number(contentLength) <= maxBytes) {
    return null;
  }

  const originalSizeBytes = contentLength ? Number(contentLength) : 0;

  logger.info(
    `Image is ${(originalSizeBytes / 1024 / 1024).toFixed(1)}MB, using Cloudflare Image Resizing to compress under ${(maxBytes / 1024 / 1024).toFixed(1)}MB limit`
  );

  // Construct a Cloudflare Image Resizing URL.
  // When fetched, Cloudflare transforms the image at the edge — the application
  // never downloads or buffers the original image.
  const parsed = new URL(absoluteUrl);
  const transformUrl = `${parsed.origin}/cdn-cgi/image/quality=85,format=jpeg${parsed.pathname}`;

  return { url: transformUrl, originalSizeBytes };
}
