import { Image, type ImageProps } from '@unpic/react';

/**
 * Cloudflare zone hostname used for URL-based image transformations
 * (`https://<domain>/cdn-cgi/image/<ops>/<source-url>`). Any hostname on the
 * openstory.so zone works; the assets domain is the one `bun setup` reminds
 * you to enable Image Transformations for, and it resolves in every
 * environment (dev, PR previews, prod).
 */
const TRANSFORM_DOMAIN =
  import.meta.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so';

/**
 * The Cloudflare zone (registrable domain) the transform endpoint lives on,
 * derived from the assets domain (`assets.openstory.so` → `openstory.so`).
 *
 * The zone's "Resize images from any origin" option is OFF: transforming a
 * source outside the zone returns a hard 403 — `onerror=redirect` does NOT
 * rescue that case — so only same-zone sources may be transformed. If the
 * option is ever enabled, this guard can be relaxed to any remote URL
 * (e.g. fal.media originals).
 */
const TRANSFORM_ZONE = TRANSFORM_DOMAIN.split('.').slice(-2).join('.');

/**
 * Canonical app origin, when configured. Stored media URLs are
 * origin-relative (`/r2/<key>`, see #894); to hand one to the Cloudflare
 * transform endpoint we need an absolute source URL, and `VITE_APP_URL` is
 * the only origin known identically on the server and the client (using the
 * runtime origin would make SSR and hydration disagree). Deployments without
 * it simply skip transforms and render a plain `<img>`.
 *
 * Never in dev: `bun dev` sets `VITE_APP_URL` to the worktree's tunnel
 * hostname, which is on the transform zone — so every stored image would go
 * out to Cloudflare and back in through the tunnel, and break whenever the
 * tunnel is not connected (`onerror=redirect` lands on the same dead host).
 * Local media is served by the local `/r2/` route; the relative src is right.
 * `DEV` is a build-time constant, so server and client still agree.
 */
const APP_ORIGIN = import.meta.env.DEV
  ? ''
  : (import.meta.env.VITE_APP_URL || '').replace(/\/$/, '');

/**
 * Absolute form of an image src: origin-relative srcs resolve against the
 * configured app origin (or null without one); absolute srcs pass through.
 * Protocol-relative `//host/...` is treated as not-ours (null → plain img):
 * it resolves cross-origin in the browser, so it must never be joined onto
 * the app origin or routed through the transform endpoint.
 */
function toAbsoluteSrc(src: string): string | null {
  if (src.startsWith('//')) return null;
  if (!src.startsWith('/')) return src;
  return APP_ORIGIN ? `${APP_ORIGIN}${src}` : null;
}

/**
 * True when `src` is an image Cloudflare's edge is allowed to fetch and
 * transform — i.e. an absolute URL on the transform zone. `data:`/`blob:`
 * URIs, local dev/e2e hosts, and cross-origin sources (fal.media) fall back
 * to a plain `<img>`.
 */
export function isTransformableUrl(src: string): boolean {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }
  return (
    url.hostname === TRANSFORM_ZONE ||
    url.hostname.endsWith(`.${TRANSFORM_ZONE}`)
  );
}

/**
 * Drop-in replacement for `@unpic/react`'s `<Image>` that routes same-zone
 * remote images through Cloudflare Image Transformations, so the browser
 * downloads resized, format-negotiated bytes (with a responsive `srcset`)
 * instead of the full-resolution original. `onerror=redirect` makes
 * Cloudflare serve the original URL if a transform fails (e.g. the source
 * 404s or can't be decoded).
 *
 * Use this instead of importing `Image` from `@unpic/react` directly.
 */
export const AppImage: React.FC<ImageProps> = (props) => {
  const absoluteSrc =
    typeof props.src === 'string' ? toAbsoluteSrc(props.src) : null;
  if (!absoluteSrc || !isTransformableUrl(absoluteSrc)) {
    return <Image {...props} />;
  }

  return (
    <Image
      // Without `cdn`, unpic passes props straight through (no inline styles),
      // so call sites size images with Tailwind classes. Keep it that way:
      // unpic's injected styles (object-fit:cover, aspect-ratio, width:100%)
      // would override those classes.
      unstyled
      {...props}
      src={absoluteSrc}
      cdn="cloudflare"
      options={{
        ...props.options,
        cloudflare: { domain: TRANSFORM_DOMAIN, ...props.options?.cloudflare },
      }}
      operations={{
        ...props.operations,
        cloudflare: {
          // unpic's provider default is fit=cover, which would crop the
          // source to the width×height box. scale-down bounds it inside the
          // box instead, preserving the source aspect ratio and never
          // upscaling.
          fit: 'scale-down',
          onerror: 'redirect',
          ...props.operations?.cloudflare,
        },
      }}
    />
  );
};
