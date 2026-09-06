/**
 * Cloudflare Media Transformations URL builders (issue #956).
 *
 * Same idea as the `cdn-cgi/image/` Image Resizing we already use for stills
 * (see `app-image.tsx`): videos stored on our Cloudflare zone can be resized
 * and have still frames extracted on the fly via a `cdn-cgi/media/` URL — no
 * pipeline change, no extra storage. Media Transformations rides on the same
 * zone toggle as Image Transformations, which is already enabled.
 *
 *   https://<zone>/cdn-cgi/media/<OPTIONS>/<ABSOLUTE-SOURCE-URL>
 *
 * Used by the logged-out sample-video showcase to serve a cheap poster frame
 * (≈36KB jpg vs a ≈4.5MB master clip) for the resting state and a downscaled
 * clip (~6× smaller) for hover playback. Sources off the zone (local `/r2`
 * dev URLs, fal.media) aren't transformable, so the builders return the
 * original URL / no poster and the caller degrades gracefully.
 */

const TRANSFORM_DOMAIN =
  import.meta.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so';

/**
 * Registrable zone the transform endpoint lives on
 * (`assets.openstory.so` → `openstory.so`). The zone's "transform from any
 * origin" option is off, so only same-zone sources may be transformed —
 * mirrors the guard in `app-image.tsx`.
 */
const TRANSFORM_ZONE = TRANSFORM_DOMAIN.split('.').slice(-2).join('.');

/** True when the edge is allowed to fetch + transform `src` (absolute, same-zone). */
export function isTransformableVideoUrl(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return (
    url.hostname === TRANSFORM_ZONE ||
    url.hostname.endsWith(`.${TRANSFORM_ZONE}`)
  );
}

function buildMediaUrl(options: string, src: string): string {
  return `https://${TRANSFORM_DOMAIN}/cdn-cgi/media/${options}/${src}`;
}

/**
 * A still-frame poster (jpg) extracted from the first frame of the video, sized
 * to `width`. Returns `undefined` for non-transformable sources so the caller
 * can fall back to the browser's own first-frame render.
 */
export function videoPosterUrl(src: string, width = 640): string | undefined {
  if (!isTransformableVideoUrl(src)) return undefined;
  // `mode=frame` is Cloudflare's Media Transformations literal for still-image
  // extraction (video still frame, NOT our domain Shot) — do not rename.
  return buildMediaUrl(`mode=frame,time=0s,format=jpg,width=${width}`, src);
}

/**
 * A downscaled, re-encoded MP4 sized to `width` — much smaller than the master
 * clip for grid-cell playback. Returns the original URL unchanged for
 * non-transformable sources.
 */
export function optimizedVideoUrl(src: string, width = 640): string {
  if (!isTransformableVideoUrl(src)) return src;
  return buildMediaUrl(`mode=video,width=${width}`, src);
}
