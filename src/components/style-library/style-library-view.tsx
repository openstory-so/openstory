import { GalleryIcon } from '@/components/icons/gallery-icon';
import { StyleDetailDialog } from '@/components/style/style-detail-dialog';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { groupStylesByCategory } from '@/lib/style/style-assets';
import { filterStyles } from '@/lib/utils/style-filters';
import type { Style } from '@/types/database';
import { Search, X } from 'lucide-react';
import type { ChangeEvent, FC } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleLibraryCard } from './style-library-card';

type StyleLibraryViewProps = {
  styles: Style[] | undefined;
  /**
   * When set, the detail dialog's "Use this style" selects the style in place
   * (composer) instead of navigating to a fresh composer (the styles-page
   * default).
   */
  onUseStyle?: (styleId: string) => void;
  /** Open scrolled to the category section containing this style — used by
   *  the composer's browse dialog so the current pick's family is in view. */
  initialStyleId?: string | null;
};

const CardGrid: FC<{ styles: Style[]; onSelect: (s: Style) => void }> = ({
  styles,
  onSelect,
}) => (
  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
    {styles.map((style) => (
      <StyleLibraryCard key={style.id} style={style} onSelect={onSelect} />
    ))}
  </div>
);

const GridSkeleton: FC = () => (
  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
    {Array.from({ length: 10 }, (_, i) => (
      <div key={i} className="flex flex-col gap-2">
        <Skeleton className="aspect-square rounded-lg" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    ))}
  </div>
);

/**
 * The browse experience shared by the top-level styles page and the composer's
 * style dialog: a search box plus category chips over a category-grouped grid,
 * each section sorted A–Z. The chips scroll to their section rather than
 * filtering. Selecting a tile opens the read-only detail dialog; from there,
 * "Use this style" selects (`onUseStyle`) or navigates to a fresh composer.
 */
export const StyleLibraryView: FC<StyleLibraryViewProps> = ({
  styles,
  onUseStyle,
  initialStyleId,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStyle, setSelectedStyle] = useState<Style | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const isLoading = styles === undefined;

  const filtered = useMemo(
    () => filterStyles(styles ?? [], 'all', searchQuery),
    [styles, searchQuery]
  );

  const groups = useMemo(() => groupStylesByCategory(filtered), [filtered]);

  const handleSelect = useCallback((style: Style) => {
    setSelectedStyle(style);
    setDetailOpen(true);
  }, []);

  const scrollToCategory = useCallback((category: string) => {
    sectionRefs.current.get(category)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  // Initial positioning only (once, instantly — not smooth): land on the
  // section holding the current selection so its family is in view on open.
  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (initialScrollDoneRef.current || !initialStyleId || isLoading) return;
    initialScrollDoneRef.current = true;
    const group = groups.find((g) =>
      g.styles.some((s) => s.id === initialStyleId)
    );
    if (!group) return;
    sectionRefs.current.get(group.category)?.scrollIntoView({
      block: 'start',
    });
  }, [initialStyleId, isLoading, groups]);

  return (
    <div className="flex flex-col gap-6">
      <div className="sticky top-0 z-10 flex flex-col gap-3 bg-background pt-1 pb-2">
        <InputGroup className="sm:max-w-xs">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            placeholder="Search styles"
            value={searchQuery}
            onChange={handleSearchChange}
            aria-label="Search styles"
          />
          {searchQuery && (
            <InputGroupAddon align="inline-end">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSearchQuery('')}
              >
                <X />
                <span className="sr-only">Clear search</span>
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>

        {groups.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {groups.map((group) => (
              <Button
                key={group.category}
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => scrollToCategory(group.category)}
              >
                {group.label}
              </Button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <GridSkeleton />
      ) : filtered.length === 0 ? (
        <Empty data-testid="styles-empty-state">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GalleryIcon size="lg" />
            </EmptyMedia>
            <EmptyTitle>No styles found</EmptyTitle>
            <EmptyDescription>
              {searchQuery
                ? 'Try adjusting your search.'
                : 'There are no styles available yet.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map((group) => (
            <section
              key={group.category}
              ref={(el) => {
                if (el) sectionRefs.current.set(group.category, el);
                else sectionRefs.current.delete(group.category);
              }}
              className="flex scroll-mt-28 flex-col gap-3"
            >
              <div className="flex items-baseline gap-2">
                <h2 className="text-lg font-semibold tracking-tight">
                  {group.label}
                </h2>
                <span className="text-sm text-muted-foreground">
                  {group.styles.length}
                </span>
              </div>
              <CardGrid styles={group.styles} onSelect={handleSelect} />
            </section>
          ))}
        </div>
      )}

      <StyleDetailDialog
        style={selectedStyle}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        onUseStyle={onUseStyle}
      />
    </div>
  );
};
