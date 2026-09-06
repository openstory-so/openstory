/**
 * Canonical public domain for SYSTEM / static assets — talent thumbnails &
 * sheets, location references, and style previews — served from the shared
 * `openstory-public-assets` R2 bucket. Distinct from `R2_PUBLIC_STORAGE_DOMAIN`
 * (per-team, user-generated media).
 *
 * VITE_-prefixed vars are client-safe and inlined by Vite at build time on
 * every target (client, SSR, workerd). Reading via `import.meta.env` avoids the
 * server-only `#env` shim, which fails at module load in Storybook and on the
 * real client.
 *
 * When the per-env override `VITE_R2_PUBLIC_ASSETS_DOMAIN` is unset or empty —
 * local dev, e2e, a CDN-less deploy, or any env that simply didn't configure it
 * — fall back to the canonical global domain. These assets are identical across
 * every environment, so the global domain is always correct; without the
 * fallback the URLs would be `https:///talent/…` (empty host), which no
 * environment can fetch — breaking seeded system cast/locations.
 */
const DEFAULT_PUBLIC_ASSETS_DOMAIN = 'assets.openstory.so';

export function getPublicAssetsDomain(): string {
  return (
    import.meta.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || DEFAULT_PUBLIC_ASSETS_DOMAIN
  );
}
