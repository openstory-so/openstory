import {
  groupStylesByCategory,
  styleCategoryGroupKey,
} from '@/lib/style/style-assets';
import type { Style } from '@/types/database';

/**
 * Composer strip default. Catalogue `sortOrder` is commercial-first (#355);
 * the script-view row promotes the cinematic family instead and lets the
 * category dropdown reach everything else.
 */
export const DEFAULT_COMPOSER_STYLE_CATEGORY = 'film';

/** Dropdown sentinel — not a `styles.category` value and not a group key. */
export const ALL_COMPOSER_STYLE_CATEGORIES = 'all';

export type ComposerStyleCategoryOption = {
  value: string;
  label: string;
};

/** Film & Cinematic first, then the usual grouped catalogue. All styles is UI. */
export function composerStyleCategoryOptions(
  styles: Style[]
): ComposerStyleCategoryOption[] {
  const groups = groupStylesByCategory(styles);
  return [
    ...groups.filter(
      (group) => group.category === DEFAULT_COMPOSER_STYLE_CATEGORY
    ),
    ...groups.filter(
      (group) => group.category !== DEFAULT_COMPOSER_STYLE_CATEGORY
    ),
  ].map((group) => ({ value: group.category, label: group.label }));
}

/**
 * Catalogue tiles for the current composer-row filter. Uses the same group
 * keys as the dropdown (`specialized`, `other`, `film`, …) so a family and
 * its strip always agree.
 */
export function stylesForComposerCategory(
  styles: Style[],
  category: string
): Style[] {
  if (category === ALL_COMPOSER_STYLE_CATEGORIES) return styles;
  return styles.filter(
    (style) => styleCategoryGroupKey(style, styles) === category
  );
}

/**
 * First style in the filtered row, falling back to the catalogue head when
 * the requested family is empty (custom teams with no cinematic styles).
 */
export function defaultComposerStyle(
  styles: Style[],
  category: string = DEFAULT_COMPOSER_STYLE_CATEGORY
): Style | undefined {
  return stylesForComposerCategory(styles, category)[0] ?? styles[0];
}

/**
 * Style to apply when the dropdown changes. `all` keeps the current pick
 * (`undefined` here) so All styles never resets to Product Ad.
 */
export function styleAfterComposerCategoryChange(
  styles: Style[],
  next: string
): Style | undefined {
  if (next === ALL_COMPOSER_STYLE_CATEGORIES) return undefined;
  return defaultComposerStyle(styles, next);
}

/**
 * How many styles in the current family are not on the strip. Recommended
 * tiles from other families do not count as shown for this family, so
 * "+N More" stays a count of hidden cinematic (etc.) tiles.
 */
export function composerCategoryHiddenCount(
  categoryStyles: Style[],
  shownIds: Iterable<string>
): number {
  const shown = shownIds instanceof Set ? shownIds : new Set(shownIds);
  let shownFromCategory = 0;
  for (const style of categoryStyles) {
    if (shown.has(style.id)) shownFromCategory += 1;
  }
  return Math.max(0, categoryStyles.length - shownFromCategory);
}

export { styleCategoryGroupKey };
