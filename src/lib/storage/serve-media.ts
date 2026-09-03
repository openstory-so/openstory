import { getEnv } from '#env';
import { serveFile } from '#storage';
import { isLocalStorageServing } from './buckets';

/**
 * Handler logic for the `/r2/$` serve route (src/routes/r2.$.ts) — split out
 * so the redirect-vs-stream decision is unit-testable:
 *
 * - Without a public CDN domain (local dev, e2e, CDN-less deploy-button
 *   workers): stream the object straight from the R2 binding.
 * - With `R2_PUBLIC_STORAGE_DOMAIN` configured: 302 to it, so media bytes
 *   are served (and cached) by the R2 domain's edge instead of this worker.
 *
 * `?download` overrides the redirect and streams with
 * `content-disposition: attachment`. The redirect is what broke "Export MP4":
 * it lands the browser on the CDN origin, where `<a download>` is ignored
 * (cross-origin) and the tab just plays the MP4 inline.
 */
export async function serveStoredMedia(
  key: string,
  request: Request
): Promise<Response> {
  const wantsDownload = new URL(request.url).searchParams.has('download');

  if (!isLocalStorageServing() && !wantsDownload) {
    return Response.redirect(
      `https://${getEnv().R2_PUBLIC_STORAGE_DOMAIN}/${key}`,
      302
    );
  }

  const response = await serveFile(key, request);
  if (!wantsDownload || !response.ok) return response;

  // No filename here — the caller's `<a download>` names the file, and it is
  // same-origin now, so it applies. Keeps user-controlled titles out of a
  // response header.
  const headers = new Headers(response.headers);
  headers.set('content-disposition', 'attachment');
  return new Response(response.body, { status: response.status, headers });
}
