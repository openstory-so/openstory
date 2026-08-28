import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StyleRecommendation } from '@/hooks/use-styles';
import {
  ALL_COMPOSER_STYLE_CATEGORIES,
  composerCategoryHiddenCount,
  stylesForComposerCategory,
} from '@/lib/style/composer-style-row';
import {
  buildRecommendationReasoningMap,
  catalogueWithoutRecommendations,
  RECOMMENDED_STYLE_SLOT_COUNT,
  resolveRecommendedStyles,
} from '@/lib/style/prioritize-recommended-styles';
import { AutoStyleTile } from '@/components/style/auto-style-tile';
import { StyleDetailDialog } from '@/components/style/style-detail-dialog';
import { StyleInlineTile } from '@/components/style/style-inline-tile';
import { StyleSelectionDialog } from './style-selection-dialog';
import type { Style } from '@/lib/db/schema/libraries';

/**
 * Keep specific styles on screen without reordering the strip: any catalogue
 * style in `keep` that fell outside the visible head is swapped into the tail
 * slots (deduped, order preserved). Used so the current selection and the last
 * browse-dialog pick stay reachable *within the current category catalogue*.
 */
function keepStylesVisible(
  head: Style[],
  catalogue: Style[],
  max: number,
  keep: Array<Style | null>
): Style[] {
  if (max <= 0) return head;
  const inCatalogue = new Set(catalogue.map((s) => s.id));
  const inHead = new Set(head.map((s) => s.id));
  const extras: Style[] = [];
  const seen = new Set<string>();
  for (const style of keep) {
    if (
      !style ||
      seen.has(style.id) ||
      inHead.has(style.id) ||
      !inCatalogue.has(style.id)
    ) {
      continue;
    }
    seen.add(style.id);
    extras.push(style);
  }
  if (extras.length === 0) return head;
  const tail = extras.slice(0, max);
  return [...head.slice(0, max - tail.length), ...tail];
}

type StyleSelectorProps = {
  styles: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  recommendations?: StyleRecommendation[];
  recommendationsLoading?: boolean;
  /** Filters the catalogue tiles. Recommendations and the browse dialog stay unfiltered. */
  categoryFilter?: string;
  /** Handles the detail dialog's "Try" — swap the composer's script for this
   *  style's sample (the composer confirms first over user-written text). */
  onTryStyle?: (styleId: string) => void;
  /** Automatic style (#1213) — the leading tile; selected when the composer
   *  asked for a script-derived style. */
  autoSelected?: boolean;
  onSelectAuto?: () => void;
};

export function StyleSelector({
  styles,
  selectedStyleId,
  onStyleSelect,
  loading = false,
  disabled = false,
  recommendations,
  recommendationsLoading = false,
  categoryFilter = ALL_COMPOSER_STYLE_CATEGORIES,
  onTryStyle,
  autoSelected = false,
  onSelectAuto,
}: StyleSelectorProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [detailStyle, setDetailStyle] = useState<Style | null>(null);
  // The last style chosen from the "browse all" dialog. It stays pinned into
  // the strip when it belongs to the current category, and only clears when
  // the composer remounts (i.e. a fresh sequence).
  const [pinnedStyleId, setPinnedStyleId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusableIndex, setFocusableIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(10);
  // False until the ResizeObserver has measured real columns. The initial
  // visibleCount is a guess, so on narrow screens the SSR/first render wraps
  // to extra rows — inside the height-capped composer card that squeezes the
  // editor, and everything reflows when the measure lands (#1187). While
  // unmeasured, the grid is clamped to one row in CSS instead.
  const [measured, setMeasured] = useState(false);

  const autoSlots = onSelectAuto ? 1 : 0;
  const reservedSlots = 1 + autoSlots;

  useEffect(() => {
    const container = gridRef.current;
    if (!container) return;

    // Read the resolved track list rather than re-deriving it from the
    // minmax/gap constants, which differ per breakpoint in the className.
    const calculateColumns = () => {
      const columns = getComputedStyle(container)
        .gridTemplateColumns.split(' ')
        .filter(Boolean).length;
      setVisibleCount(Math.max(3, columns));
      setMeasured(true);
    };

    calculateColumns();

    const observer = new ResizeObserver(() => calculateColumns());

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const showRecommendations =
    recommendationsLoading || (recommendations?.length ?? 0) > 0;

  const recommendedStyles = useMemo(
    () =>
      showRecommendations
        ? resolveRecommendedStyles(styles, recommendations)
        : [],
    [styles, recommendations, showRecommendations]
  );

  const reasoningByStyleId = useMemo(
    () => buildRecommendationReasoningMap(recommendations),
    [recommendations]
  );

  const showRecommendationSkeleton =
    showRecommendations &&
    recommendationsLoading &&
    recommendedStyles.length === 0;

  const recommendationSlotCount = showRecommendations
    ? showRecommendationSkeleton
      ? RECOMMENDED_STYLE_SLOT_COUNT
      : recommendedStyles.length
    : 0;

  const categoryStyles = useMemo(
    () => stylesForComposerCategory(styles, categoryFilter),
    [styles, categoryFilter]
  );

  const catalogueStyles = useMemo(
    () =>
      catalogueWithoutRecommendations(
        categoryStyles,
        showRecommendations ? recommendations : undefined
      ),
    [categoryStyles, recommendations, showRecommendations]
  );

  const selectedStyle = styles.find((s) => s.id === selectedStyleId) ?? null;
  const pinnedStyle = pinnedStyleId
    ? (styles.find((s) => s.id === pinnedStyleId) ?? null)
    : null;

  const maxCatalogueSlots = Math.max(
    0,
    visibleCount - reservedSlots - recommendationSlotCount
  );
  // Show the first N catalogue tiles in stable order (selecting must never
  // shuffle tiles to the front). Keep the current selection visible — it may
  // come from outside the strip (a URL `?style=`, the browse dialog) — plus the
  // last browse-dialog pick, which stays pinned while other tiles are selected.
  const visibleCatalogueStyles = keepStylesVisible(
    catalogueStyles.slice(0, maxCatalogueSlots),
    catalogueStyles,
    maxCatalogueSlots,
    [pinnedStyle, selectedStyle]
  );

  const moreIndex =
    autoSlots + recommendationSlotCount + visibleCatalogueStyles.length;
  const totalItems = moreIndex + 1;

  const shownStyleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const style of recommendedStyles) ids.add(style.id);
    for (const style of visibleCatalogueStyles) ids.add(style.id);
    return ids;
  }, [recommendedStyles, visibleCatalogueStyles]);

  const hiddenCount = composerCategoryHiddenCount(
    categoryStyles,
    shownStyleIds
  );

  useEffect(() => {
    if (autoSelected && autoSlots > 0) {
      setFocusableIndex(0);
      return;
    }

    const recIndex = recommendedStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (recIndex !== -1) {
      setFocusableIndex(autoSlots + recIndex);
      return;
    }

    const catalogueIndex = visibleCatalogueStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (catalogueIndex !== -1) {
      setFocusableIndex(autoSlots + recommendationSlotCount + catalogueIndex);
      return;
    }

    if (totalItems > 0) setFocusableIndex(0);
  }, [
    autoSelected,
    autoSlots,
    selectedStyleId,
    recommendedStyles,
    visibleCatalogueStyles,
    recommendationSlotCount,
    totalItems,
  ]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, currentIndex: number) => {
      let nextIndex = currentIndex;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = Math.min(currentIndex + 1, totalItems - 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case 'Home':
          event.preventDefault();
          nextIndex = 0;
          break;
        case 'End':
          event.preventDefault();
          nextIndex = totalItems - 1;
          break;
        default:
          return;
      }

      if (nextIndex !== currentIndex) {
        setFocusableIndex(nextIndex);
        // The style tiles and the trailing "More" tile carry the roving
        // tabindex, in render order — index them directly.
        const tiles = gridRef.current?.querySelectorAll('[data-style-tile]');
        const nextTile = tiles?.[nextIndex];
        if (nextTile instanceof HTMLElement) {
          nextTile.focus();
        }
      }
    },
    [totalItems]
  );

  const handleStyleSelect = (styleId: string) => {
    // Pin the browse-dialog pick so it stays in the strip afterwards.
    setPinnedStyleId(styleId);
    onStyleSelect(styleId);
    setDialogOpen(false);
  };

  return (
    <>
      <div
        ref={gridRef}
        className={cn(
          'grid w-full grid-cols-[repeat(auto-fill,minmax(56px,1fr))] gap-2 py-1 sm:grid-cols-[repeat(auto-fill,minmax(65px,1fr))] sm:gap-3 sm:py-2',
          // Unmeasured: clamp to one row so the guessed tile count can't wrap
          // and change the grid's height. Row 1 is an explicit auto track;
          // overflow rows get zero height + zero row-gap and are clipped; the
          // bottom padding moves outside the clip (pb-0 + mb-2) so overflow
          // tiles can't peek into it. Total height matches the measured state
          // exactly: pt + row + mb == pt + row + pb at each breakpoint.
          // The clip is a clip-path, not overflow-hidden, so it can extend
          // 2px past the box on the sides and bottom: the selected tile's
          // scale-105 bleeds ~1.6px and overflow-hidden shaved its highlight
          // (#1279). Overflow tiles peek 2px into that slack — transparent
          // border for style tiles; a faint dashed sliver if "+N More" wraps.
          !measured &&
            // sm:py-2 beats unprefixed pb-0, so sm:pb-0 is required or SSR
            // keeps padding AND sm:mb-2 — an 8px jump when measured (#1255).
            'grid-rows-[auto] [grid-auto-rows:0] gap-y-0 [clip-path:inset(0_-2px_-2px)] pb-0 mb-1 sm:pb-0 sm:mb-2'
        )}
        role="grid"
        aria-label="Style selection"
      >
        {loading ? (
          Array.from({ length: visibleCount }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))
        ) : (
          <>
            {onSelectAuto && (
              <AutoStyleTile
                selected={autoSelected}
                disabled={disabled}
                tabIndex={focusableIndex === 0 ? 0 : -1}
                onSelect={onSelectAuto}
                onKeyDown={(e) => handleKeyDown(e, 0)}
              />
            )}
            {showRecommendationSkeleton
              ? Array.from({ length: RECOMMENDED_STYLE_SLOT_COUNT }, (_, i) => (
                  <Skeleton
                    key={`rec-skeleton-${i}`}
                    className="aspect-square rounded-lg"
                  />
                ))
              : recommendedStyles.map((style, index) => (
                  <StyleInlineTile
                    key={style.id}
                    style={style}
                    selected={selectedStyleId === style.id}
                    disabled={disabled}
                    recommended
                    priority={index < 4}
                    reasoning={reasoningByStyleId.get(style.id)}
                    tabIndex={autoSlots + index === focusableIndex ? 0 : -1}
                    onSelect={onStyleSelect}
                    onShowDetails={() => setDetailStyle(style)}
                    onKeyDown={(e) => handleKeyDown(e, autoSlots + index)}
                  />
                ))}

            {visibleCatalogueStyles.map((style, index) => {
              const unifiedIndex = autoSlots + recommendationSlotCount + index;
              return (
                <StyleInlineTile
                  key={style.id}
                  style={style}
                  selected={selectedStyleId === style.id}
                  disabled={disabled}
                  priority={unifiedIndex < 4}
                  tabIndex={unifiedIndex === focusableIndex ? 0 : -1}
                  onSelect={onStyleSelect}
                  onShowDetails={() => setDetailStyle(style)}
                  onKeyDown={(e) => handleKeyDown(e, unifiedIndex)}
                />
              );
            })}

            <button
              type="button"
              data-style-tile
              onClick={() => setDialogOpen(true)}
              onKeyDown={(e) => handleKeyDown(e, moreIndex)}
              tabIndex={moreIndex === focusableIndex ? 0 : -1}
              disabled={disabled}
              className={cn(
                'aspect-square rounded-lg overflow-hidden',
                'border-2 border-dashed border-muted-foreground/30',
                'flex flex-col items-center justify-center gap-2',
                'hover:border-primary hover:bg-muted/50',
                'transition-all duration-200',
                'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
              aria-label={`View all ${styles.length} styles`}
            >
              <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground font-medium text-center">
                {hiddenCount > 0
                  ? `+${hiddenCount} More`
                  : `View All (${styles.length})`}
              </span>
            </button>
          </>
        )}
      </div>
      <StyleSelectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        styles={styles}
        onStyleSelect={handleStyleSelect}
        selectedStyleId={selectedStyleId}
      />

      <StyleDetailDialog
        style={detailStyle}
        open={detailStyle !== null}
        onOpenChange={(open) => {
          if (!open) setDetailStyle(null);
        }}
        onUseStyle={onStyleSelect}
        onTryStyle={onTryStyle}
      />
    </>
  );
}
