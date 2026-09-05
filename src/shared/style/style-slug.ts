/**
 * Canonical slug for a style name.
 *
 * This is the single source of truth for the URL/folder segment used by every
 * style asset: thumbnails (`/styles/{slug}/thumbnail.webp`), canonical and
 * bespoke sample videos (`/styles/{slug}/canonical.mp4`, `bespoke.mp4`), and
 * the local `preview/` + `sample-videos/` output directories. The thumbnail URL
 * builder, the preview generator, the upload scripts, and the sample-video seed
 * all derive their paths from here so the segments can never drift apart.
 */
export function styleSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // drop punctuation, keep spaces + hyphens
    .replace(/\s+/g, '-') // spaces → hyphens
    .replace(/-+/g, '-') // collapse repeats
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
}
