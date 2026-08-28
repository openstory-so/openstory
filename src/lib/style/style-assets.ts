import type { Style } from '@/types/database';

/**
 * Client-safe helpers for deriving a style's public media assets from the
 * `previewUrl` that every seeded style carries.
 *
 * Every style's assets live under a single `/styles/{slug}/` folder on the
 * public assets bucket (see `style-slug.ts`). The seeded `previewUrl` is always
 * `…/styles/{slug}/thumbnail.webp`, so the hover clip, canonical sample video,
 * and the three preview stills are all reachable by swapping the trailing
 * filename — no need to re-derive the slug or know the assets domain here.
 */

/** The suffix every seeded `previewUrl` ends with. */
const THUMBNAIL_SUFFIX = '/thumbnail.webp';

/**
 * Swap the `thumbnail.webp` filename on a style's preview URL for another asset
 * in the same folder. Returns null when the style has no preview URL or it
 * isn't the expected thumbnail shape (e.g. a user-uploaded custom style), so
 * callers degrade to the gradient/no-video fallback rather than 404.
 */
function styleAssetUrl(style: Style, file: string): string | null {
  const url = style.previewUrl;
  if (!url || !url.endsWith(THUMBNAIL_SUFFIX)) return null;
  return url.slice(0, -'thumbnail.webp'.length) + file;
}

/**
 * The looping hover-preview clip (`hover.mp4`) — a short, silent, square video
 * that animates the same composition the thumbnail was cut from. Null when the
 * style has no derivable asset folder.
 */
export function styleHoverVideoUrl(style: Style): string | null {
  return styleAssetUrl(style, 'hover.mp4');
}

/**
 * The canonical sample video for the style. Prefers the persisted
 * `sampleVideos` entry (authoritative URL + metadata) and falls back to the
 * derived `canonical.mp4` path for styles seeded before that column existed.
 */
export function styleCanonicalVideoUrl(style: Style): string | null {
  const canonical = style.sampleVideos?.find((v) => v.kind === 'canonical');
  if (canonical) return canonical.url;
  return styleAssetUrl(style, 'canonical.mp4');
}

/**
 * The bespoke "showcase" sample video — present only for hero styles (those
 * seeded with a curated bespoke entry). Null otherwise; unlike the canonical
 * there's no derived fallback, since non-hero styles have no bespoke asset.
 */
export function styleBespokeVideoUrl(style: Style): string | null {
  return style.sampleVideos?.find((v) => v.kind === 'bespoke')?.url ?? null;
}

/**
 * Categories whose preview stills are shot as products (hero/detail/context)
 * rather than people (character/environment/action). Mirrors the scene split in
 * `scripts/generate-style-previews.ts` so the URLs we derive here line up with
 * the renders that script produced.
 */
const PRODUCT_CATEGORIES = new Set(['ecommerce', 'food', 'automotive']);

const PEOPLE_SCENES = ['character', 'environment', 'action'] as const;
const PRODUCT_SCENES = ['hero', 'detail', 'context'] as const;

/** The three preview scene names rendered for a style (product vs. people). */
export function stylePreviewSceneNames(style: Style): readonly string[] {
  const isProduct =
    PRODUCT_CATEGORIES.has(style.category ?? '') ||
    (style.category === 'commercial' && style.useCases?.[0] === 'product');
  return isProduct ? PRODUCT_SCENES : PEOPLE_SCENES;
}

/**
 * URLs for the three full-res preview stills (`{scene}.webp`) shown in the
 * style detail view. Empty when the style has no derivable asset folder. Some
 * older styles never rendered all three scenes, so individual URLs may 404 —
 * callers should hide a still that fails to load rather than show a broken box.
 */
export function stylePreviewImageUrls(style: Style): string[] {
  return stylePreviewSceneNames(style)
    .map((scene) => styleAssetUrl(style, `${scene}.webp`))
    .filter((url): url is string => url !== null);
}

/**
 * Friendly labels for the style categories used across the template catalogue.
 * Categories are displayed in alphabetical order by label; the special
 * `specialized` bucket always sorts last (see `groupStylesByCategory`).
 * Categories not listed here fall back to a title-cased version of the raw
 * value.
 */
const STYLE_CATEGORY_LABELS: Record<string, string> = {
  commercial: 'Commercial',
  ecommerce: 'E-commerce',
  influencer: 'Influencer & UGC',
  film: 'Film & Cinematic',
  animation: 'Animation',
  animatic: 'Animatic & Previz',
  kids: 'Kids',
  tech: 'Tech',
  specialized: 'Specialized',
};

/** Synthetic key for styles missing a category. */
const UNCATEGORIZED_KEY = '__other__';

/**
 * The trailing catch-all group that small/niche categories collapse into so the
 * browse experience isn't littered with one-style sections.
 */
export const SPECIALIZED_CATEGORY = 'specialized';

/** Categories with fewer styles than this collapse into "Specialized". */
const SMALL_CATEGORY_THRESHOLD = 3;

/**
 * Categories that sink to the end of the list (after the A–Z run), in this
 * order, just before the "Specialized" catch-all. Everything else sorts A–Z.
 */
const TRAILING_CATEGORY_ORDER = ['animation', 'animatic', SPECIALIZED_CATEGORY];

function categorySortRank(category: string): number {
  const index = TRAILING_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? 0 : index + 1;
}

/**
 * Raw category keys (including the uncategorized bucket) that hold fewer than
 * `SMALL_CATEGORY_THRESHOLD` styles in the given catalogue, and therefore
 * collapse into the trailing "Specialized" group.
 */
export function smallCategoryKeys(styles: Style[]): Set<string> {
  const counts = new Map<string, number>();
  for (const style of styles) {
    const key = style.category ?? UNCATEGORIZED_KEY;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const small = new Set<string>();
  for (const [key, count] of counts) {
    if (count < SMALL_CATEGORY_THRESHOLD) small.add(key);
  }
  return small;
}

/** Friendly heading for a style category (title-cases unknown values). */
export function styleCategoryLabel(
  category: string | null | undefined
): string {
  if (!category) return 'Other';
  return (
    STYLE_CATEGORY_LABELS[category] ??
    category.charAt(0).toUpperCase() + category.slice(1)
  );
}

/**
 * The group key a style lands in after small-category collapse. Matches
 * `groupStylesByCategory` so a composer filter and the browse-page sections
 * agree on Specialized vs a named family.
 */
export function styleCategoryGroupKey(
  style: Style,
  catalogue: Style[]
): string {
  const rawKey = style.category ?? UNCATEGORIZED_KEY;
  if (smallCategoryKeys(catalogue).has(rawKey)) return SPECIALIZED_CATEGORY;
  return style.category ?? 'other';
}

export type StyleCategoryGroup = {
  category: string;
  label: string;
  styles: Style[];
};

/**
 * Bucket styles into category groups, alphabetically by label, with the
 * "Specialized" catch-all last. Categories with fewer than
 * `SMALL_CATEGORY_THRESHOLD` styles (and uncategorized styles) collapse into
 * Specialized; styles within each group are sorted A–Z by name.
 */
export function groupStylesByCategory(styles: Style[]): StyleCategoryGroup[] {
  const small = smallCategoryKeys(styles);
  const byCategory = new Map<string, Style[]>();
  for (const style of styles) {
    const rawKey = style.category ?? UNCATEGORIZED_KEY;
    const key = small.has(rawKey) ? SPECIALIZED_CATEGORY : rawKey;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(style);
    else byCategory.set(key, [style]);
  }

  return [...byCategory.entries()]
    .map(([category, groupStyles]) => ({
      category: category === UNCATEGORIZED_KEY ? 'other' : category,
      label:
        category === UNCATEGORIZED_KEY ? 'Other' : styleCategoryLabel(category),
      styles: [...groupStyles].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      // Animation, Animatic, then "Specialized" sink to the end (in that
      // order); everything else sorts A–Z by label.
      const rankDelta =
        categorySortRank(a.category) - categorySortRank(b.category);
      if (rankDelta !== 0) return rankDelta;
      return a.label.localeCompare(b.label);
    });
}
