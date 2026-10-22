import { Card } from '@/ui/shadcn/card';
import { useVirtualizer } from '@tanstack/react-virtual';
import type React from 'react';
import { useCallback, useState, useSyncExternalStore } from 'react';

/** Characters and locations lay out on the same grid. */
const LIBRARY_GRID_CLASS =
  'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4';

export const LibraryGridSkeleton: React.FC = () => (
  <div className={LIBRARY_GRID_CLASS}>
    {[1, 2, 3, 4, 5, 6].map((n) => (
      <Card key={`skeleton-${n}`} className="overflow-hidden animate-pulse">
        <div className="aspect-square bg-muted" />
        <div className="p-4">
          <div className="h-4 bg-muted rounded w-3/4 mb-2" />
          <div className="h-3 bg-muted rounded w-1/2" />
        </div>
      </Card>
    ))}
  </div>
);

const subscribeToResize = (onChange: () => void) => {
  window.addEventListener('resize', onChange);
  return () => window.removeEventListener('resize', onChange);
};

/** The column count `LIBRARY_GRID_CLASS` lays out at this width. */
const gridColumns = () =>
  window.innerWidth >= 1280
    ? 5
    : window.innerWidth >= 1024
      ? 4
      : window.innerWidth >= 768
        ? 3
        : 2;

/**
 * A team library as a grid of cards (#2017, #1695). Everything the team has
 * is listed, so the rows are virtualized against the page's scroller.
 */
export function LibraryVirtualGrid<T extends { id: string }>({
  items,
  scrollRef,
  estimateRowHeight,
  renderItem,
}: {
  items: readonly T[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  estimateRowHeight: number;
  renderItem: (item: T) => React.ReactNode;
}) {
  const columns = useSyncExternalStore(subscribeToResize, gridColumns, () => 2);
  // Where the list starts inside the page's scroller, measured when the
  // list mounts (a ref callback, not a read of a ref during render).
  const [scrollMargin, setScrollMargin] = useState(0);
  const measure = useCallback((list: HTMLDivElement | null) => {
    if (list) setScrollMargin(list.offsetTop);
  }, []);
  const virtualizer = useVirtualizer({
    count: Math.ceil(items.length / columns),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 3,
    scrollMargin,
  });

  return (
    <div
      ref={measure}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          ref={virtualizer.measureElement}
          data-index={row.index}
          className="absolute left-0 top-0 w-full pb-4"
          style={{ transform: `translateY(${row.start - scrollMargin}px)` }}
        >
          <div className={LIBRARY_GRID_CLASS}>
            {items
              .slice(row.index * columns, (row.index + 1) * columns)
              .map((item) => (
                <div key={item.id}>{renderItem(item)}</div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
