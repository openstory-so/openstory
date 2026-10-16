import { LIBRARY_GRID_CLASS } from '@/cast/ui/talent-library/talent-library-list';
import { useVirtualizer } from '@tanstack/react-virtual';
import type React from 'react';
import { useCallback, useState, useSyncExternalStore } from 'react';

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
