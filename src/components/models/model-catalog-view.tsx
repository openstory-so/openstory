import { ModelFamilyCard } from '@/components/models/model-family-card';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { listCatalogModelFamiliesFn } from '@/functions/model-catalog';
import {
  CATALOG_ACTIVITIES,
  type CatalogActivity,
} from '@/shared/models/catalog';
import { useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { Boxes, Search, X } from 'lucide-react';
import type { ChangeEvent, FC, FormEvent } from 'react';
import { Suspense, useEffect, useRef, useState } from 'react';

const ACTIVITY_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'audio', label: 'Audio' },
] as const;

const SEARCH_DEBOUNCE_MS = 300;

type ModelCatalogViewProps = {
  /** URL-owned filters (undefined = All / no search). */
  activity: CatalogActivity | undefined;
  q: string | undefined;
  onActivityChange: (activity: CatalogActivity | undefined) => void;
  onSearchChange: (q: string | undefined) => void;
};

const GRID_CLASSES =
  'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

const GridSkeleton: FC = () => (
  <div className={GRID_CLASSES}>
    {Array.from({ length: 10 }, (_, i) => (
      <div key={i} className="flex flex-col gap-2">
        <Skeleton className="aspect-video rounded-xl" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    ))}
  </div>
);

/**
 * The paged results grid. Separate from the filter bar so suspending on a
 * filter change swaps only the grid for skeletons — search input and pills
 * stay mounted and interactive.
 */
const ModelResults: FC<{
  activity: CatalogActivity | undefined;
  q: string | undefined;
}> = ({ activity, q }) => {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useSuspenseInfiniteQuery({
    queryKey: ['model-catalog', activity ?? 'all', q ?? ''],
    queryFn: ({ pageParam }) =>
      listCatalogModelFamiliesFn({
        data: {
          activity,
          q: q || undefined,
          cursor: pageParam || undefined,
        },
      }),
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 5 * 60 * 1000,
  });

  const families = data.pages.flatMap((page) => page.families);

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '400px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (families.length === 0) {
    return (
      <Empty data-testid="models-empty-state">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Boxes />
          </EmptyMedia>
          <EmptyTitle>No models found</EmptyTitle>
          <EmptyDescription>
            Try a different search or activity filter.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col items-center gap-6">
      <div className={`w-full ${GRID_CLASSES}`}>
        {families.map((family) => (
          // Family paths are only unique per activity, so the "All" view can
          // repeat one; the representative belongs to exactly one family, so
          // its endpoint id is a safe key.
          <ModelFamilyCard
            key={family.representative.endpointId}
            family={family}
          />
        ))}
      </div>
      {hasNextPage && (
        <>
          {/* Auto-loads ahead of the scroll edge; the button is the visible,
              keyboard-reachable fallback. */}
          <div ref={sentinelRef} aria-hidden="true" />
          {isFetchNextPageError && (
            <p role="alert" className="text-sm text-destructive">
              Couldn't load more models.
            </p>
          )}
          <Button
            variant="outline"
            onClick={() => void fetchNextPage()}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage
              ? 'Loading…'
              : isFetchNextPageError
                ? 'Try again'
                : 'Load more'}
          </Button>
        </>
      )}
    </div>
  );
};

/**
 * The browse experience for the Models catalog page: debounced search
 * (Enter commits immediately) and activity pills over an infinite-scrolling
 * card grid. Both filters are owned by the route (URL-reflected).
 */
export const ModelCatalogView: FC<ModelCatalogViewProps> = ({
  activity,
  q,
  onActivityChange,
  onSearchChange,
}) => {
  // Local echo of the URL's q so typing is instant; commits are debounced.
  // Deliberately not synced back from the URL (matches StyleLibraryView):
  // syncing would clobber keystrokes typed between commit and navigation.
  const [search, setSearch] = useState(q ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const commitSearch = (value: string) => {
    clearTimeout(debounceRef.current);
    onSearchChange(value.trim() || undefined);
  };

  const handleSearchInput = (event: ChangeEvent<HTMLInputElement>) => {
    const { value } = event.target;
    setSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      () => commitSearch(value),
      SEARCH_DEBOUNCE_MS
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    commitSearch(search);
  };

  const handleClear = () => {
    setSearch('');
    commitSearch('');
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <form onSubmit={handleSubmit}>
          <InputGroup className="sm:max-w-xs">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              placeholder="Search models"
              value={search}
              onChange={handleSearchInput}
              aria-label="Search models"
            />
            {search && (
              <InputGroupAddon align="inline-end">
                <Button variant="ghost" size="icon" onClick={handleClear}>
                  <X />
                  <span className="sr-only">Clear search</span>
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
        </form>

        <ToggleGroup
          type="single"
          value={activity ?? 'all'}
          onValueChange={(value) =>
            onActivityChange(CATALOG_ACTIVITIES.find((a) => a === value))
          }
          className="flex flex-wrap justify-start"
        >
          {ACTIVITY_FILTERS.map((filter) => (
            <ToggleGroupItem
              key={filter.value}
              value={filter.value}
              className="rounded-full"
            >
              {filter.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Suspense fallback={<GridSkeleton />}>
        <ModelResults activity={activity} q={q} />
      </Suspense>
    </div>
  );
};
