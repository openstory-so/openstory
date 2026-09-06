/**
 * CORS Cache Buster — workaround for a CDN-cache-key collision between
 * media-element loads and `fetch()`.
 *
 * The problem
 * -----------
 * Cloudflare's edge caches per-URL. The *first* response cached for a URL is
 * what subsequent requests get, regardless of who's asking.
 *
 *   1. App renders `<video src="…/scene.mp4">`. Browsers do NOT send an
 *      `Origin` header for media-element loads by default, so R2 replies
 *      without any `Access-Control-Allow-Origin` (there's no Origin to
 *      allow). Cloudflare caches that headerless response.
 *   2. Later, mediabunny calls `fetch("…/scene.mp4")` with `Range`. `fetch()`
 *      always sends `Origin` for cross-origin URLs, so the browser enforces
 *      CORS on the response. Cloudflare serves the cached headerless
 *      response. Browser sees no `Access-Control-Allow-Origin`, rejects it
 *      with `net::ERR_FAILED`.
 *
 * The fix
 * -------
 * Append a constant query param to the URL we hand to mediabunny so it lives
 * under a separate CDN cache key from the one the `<video>`/`<audio>` element
 * uses. Mediabunny's fetch warms its own cache slot with the correct CORS
 * headers (because the fetch sends `Origin`, R2 sees it, R2 includes the
 * allow-origin header in the reply).
 *
 * Why a constant (not random) param: second loads of the same URL by the same
 * client still hit the CDN cache — the slot just happens to be the "CORS"
 * slot rather than the "no-CORS" slot. No per-render slowdown.
 *
 * Why not just add `crossOrigin="anonymous"` to every `<video>`/`<audio>`:
 *   - It assumes every URL is CORS-friendly. fal.media URLs (used for some
 *     preview images and for loudness-normalized audio inputs) don't reply
 *     with CORS headers for our origins → element breaks.
 *   - It triggers a Chromium quirk specifically for `<audio>` with
 *     open-ended `Range: bytes=0-` requests: the GET goes out *without*
 *     preflight and *without* an `Origin` header, R2 replies without
 *     CORS headers, and Chromium then rejects the response as
 *     `net::ERR_FAILED` even though the preflight (if it had run) would
 *     have succeeded.
 *
 * Why not fix it at the CDN: a Cloudflare cache rule that varies the cache
 * key on the `Origin` header would also solve this, but requires per-zone
 * configuration we don't control reliably across all envs. This workaround
 * lives in the codebase and travels with the app.
 *
 * When to use it
 * --------------
 * Apply this ONLY to URLs you hand to mediabunny (or any other code path
 * that fetches the asset with an `Origin` header). Do NOT apply it to URLs
 * rendered in `<video>` / `<audio>` / `<img>` elements — that would defeat
 * the purpose by sharing the same key again.
 */
export function addCorsCacheBuster(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_cors=1`;
}
