/**
 * Studio composer max-height (#1474).
 *
 * A long prompt used to grow the bottom pane until the gallery was a sliver.
 * The pane still sizes to its content, but it may not occupy more than this
 * fraction of the studio column. The divider handle writes the same value
 * to localStorage so the split survives reloads.
 */

export const STUDIO_COMPOSER_MAX_HEIGHT_KEY =
  'openstory:studio-composer-max:v1';

/** Default: gallery stays on screen; the reporter prototyped 50% in DevTools. */
export const DEFAULT_STUDIO_COMPOSER_MAX_FRACTION = 0.4;

export const MIN_STUDIO_COMPOSER_MAX_FRACTION = 0.2;
export const MAX_STUDIO_COMPOSER_MAX_FRACTION = 0.7;

/** Floor so the toolbar + one prompt line still fit on a short phone. */
export const MIN_STUDIO_COMPOSER_PX = 160;

/** Floor so a row of stills remains visible above the pane. */
export const MIN_STUDIO_GALLERY_PX = 140;

export const STUDIO_COMPOSER_KEYBOARD_STEP = 0.05;

export function clampStudioComposerMaxFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_STUDIO_COMPOSER_MAX_FRACTION;
  return Math.min(
    MAX_STUDIO_COMPOSER_MAX_FRACTION,
    Math.max(MIN_STUDIO_COMPOSER_MAX_FRACTION, value)
  );
}

export function parseStudioComposerMaxFraction(raw: string | null): number {
  if (raw == null || raw === '') return DEFAULT_STUDIO_COMPOSER_MAX_FRACTION;
  return clampStudioComposerMaxFraction(Number(raw));
}

/** Composer share of the column from a pointer sitting on the top edge. */
export function composerMaxFractionFromPointer({
  columnHeight,
  columnBottom,
  clientY,
}: {
  columnHeight: number;
  columnBottom: number;
  clientY: number;
}): number {
  if (columnHeight <= 0) return DEFAULT_STUDIO_COMPOSER_MAX_FRACTION;
  return clampStudioComposerMaxFraction(
    (columnBottom - clientY) / columnHeight
  );
}

export function studioComposerMaxHeightCss(fraction: number): string {
  const percent = clampStudioComposerMaxFraction(fraction) * 100;
  return `min(max(${MIN_STUDIO_COMPOSER_PX}px, ${percent}%), calc(100% - ${MIN_STUDIO_GALLERY_PX}px))`;
}

export function loadStudioComposerMaxFraction(): number {
  if (typeof window === 'undefined')
    return DEFAULT_STUDIO_COMPOSER_MAX_FRACTION;
  try {
    return parseStudioComposerMaxFraction(
      localStorage.getItem(STUDIO_COMPOSER_MAX_HEIGHT_KEY)
    );
  } catch {
    return DEFAULT_STUDIO_COMPOSER_MAX_FRACTION;
  }
}

export function saveStudioComposerMaxFraction(value: number): number {
  const next = clampStudioComposerMaxFraction(value);
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STUDIO_COMPOSER_MAX_HEIGHT_KEY, String(next));
    } catch {
      // private mode / quota — keep the in-memory value
    }
  }
  return next;
}
