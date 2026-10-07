import { TeamCharacterCard } from '@/cast/ui/character-library/team-character-card';
import { LIBRARY_GRID_CLASS } from '@/cast/ui/talent-library/talent-library-list';
import { useTeamCharacters } from '@/cast/ui/use-team-characters';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { useVirtualizer } from '@tanstack/react-virtual';
import { User } from 'lucide-react';
import type React from 'react';
import { useRef, useSyncExternalStore } from 'react';

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
 * The team's characters as a grid (#2017). Every sequence's one-off
 * characters are here too, so the rows are virtualized against the page's
 * scroller.
 */
export const TeamCharacterList: React.FC<{
  inLibrary: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}> = ({ inLibrary, scrollRef }) => {
  const { data: characters } = useTeamCharacters(inLibrary);
  const columns = useSyncExternalStore(subscribeToResize, gridColumns, () => 2);
  const listRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(characters.length / columns);
  const scrollMargin = listRef.current?.offsetTop ?? 0;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 320,
    overscan: 3,
    scrollMargin,
  });

  if (characters.length === 0) {
    return (
      <EmptyState
        icon={<User className="h-12 w-12" />}
        title={inLibrary ? 'Library is empty' : 'No characters yet'}
        description={
          inLibrary
            ? 'Open a character and add it to the library.'
            : 'Characters appear here when a sequence is analysed.'
        }
      />
    );
  }

  return (
    <div
      ref={listRef}
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
            {characters
              .slice(row.index * columns, (row.index + 1) * columns)
              .map((character) => (
                <TeamCharacterCard key={character.id} character={character} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
};
