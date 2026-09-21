import type React from 'react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { ArchivedSequences } from '@/sequences/ui/archived-sequences';
import { EvalToolbar } from './eval-toolbar';
import { SequenceGallery } from './sequence-gallery';
import { useIsMobile } from '@/ui/use-mobile';

import {
  useSequencesWithShots,
  type SequenceWithShots,
} from '@/sequences/ui/use-sequences-with-shots';
import { useTeamDivergentSequenceVariants } from '@/audio/ui/use-sequence-variants';
import { useStyles } from '@/look/ui/use-styles';
import { isSystemAdminFn } from '@/billing/gift-tokens.fn';
import { useQuery, useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { Card } from '@/ui/shadcn/card';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { Button } from '@/ui/shadcn/button';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { VideoIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { AspectRatio } from '@/models/aspect-ratios';
import type {
  SequencesListPrefs,
  SequencesListSearch,
} from '@/sequences/ui/list-prefs';
import { getCreatorIdentity } from './creator-identity';
import {
  getAdminShotsFn,
  getAllAdminSequencesFn,
} from '@/platform/admin-support.fn';
import type { Sequence } from '@/platform/server/db/schema';
import type { ShotView } from '@/shots/shot-view';

const EvalMatrix = lazy(() =>
  import('./eval-matrix').then((m) => ({ default: m.EvalMatrix }))
);
const EvalSequencesMobile = lazy(() =>
  import('./eval-sequences-mobile').then((m) => ({
    default: m.EvalSequencesMobile,
  }))
);

const PAGE_SIZE = 50;

const adminSupportKeys = {
  all: ['admin-support'] as const,
  sequences: (search?: string) =>
    [...adminSupportKeys.all, 'sequences', search ?? ''] as const,
  shots: (sequenceId: string) =>
    [...adminSupportKeys.all, 'shots', sequenceId] as const,
};

type AdminSequenceWithShots = SequenceWithShots & {
  creatorName: string | null;
  creatorEmail: string | null;
};

function useAdminAllSequencesWithShots(
  enabled: boolean,
  loadShots: boolean,
  search?: string
) {
  const trimmedSearch = search?.trim() || undefined;

  const {
    data: infiniteData,
    isLoading: seqLoading,
    error: seqError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: adminSupportKeys.sequences(trimmedSearch),
    queryFn: ({ pageParam }) =>
      getAllAdminSequencesFn({
        data: {
          limit: PAGE_SIZE,
          offset: pageParam * PAGE_SIZE,
          search: trimmedSearch,
        },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.length === PAGE_SIZE ? lastPageParam + 1 : undefined,
    enabled,
    refetchOnMount: 'always',
    staleTime: 60_000,
  });

  const allSequences = useMemo(
    () => infiniteData?.pages.flat() ?? [],
    [infiniteData]
  );

  const shotsQueries = useQueries({
    queries: (enabled && loadShots ? allSequences : []).map(
      (seq: Sequence) => ({
        queryKey: adminSupportKeys.shots(seq.id),
        queryFn: async (): Promise<ShotView[]> => {
          return getAdminShotsFn({ data: { sequenceId: seq.id } });
        },
        staleTime: 60_000,
        enabled: allSequences.length > 0,
      })
    ),
  });

  const data = useMemo<AdminSequenceWithShots[]>(() => {
    if (allSequences.length === 0) return [];
    return allSequences.map(
      (
        seq: Sequence & {
          creatorName: string | null;
          creatorEmail: string | null;
        },
        i: number
      ) => ({
        ...seq,
        shots: shotsQueries[i]?.data ?? [],
      })
    );
  }, [allSequences, shotsQueries]);

  const shotsLoadingMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    allSequences.forEach((seq, i) => {
      const q = shotsQueries[i];
      map[seq.id] = Boolean(q?.isLoading);
    });
    return map;
  }, [allSequences, shotsQueries]);

  const error = seqError || shotsQueries.find((q) => q.error)?.error;

  return {
    data,
    isLoading: seqLoading,
    shotsLoadingMap,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  };
}

export type ViewMode = 'script' | 'prompts' | 'images' | 'motion';
export type ListViewMode = 'gallery' | ViewMode;

export function isValidViewMode(value: string): value is ViewMode {
  return (
    value === 'script' ||
    value === 'prompts' ||
    value === 'images' ||
    value === 'motion'
  );
}

export type FilterState = {
  search: string;
  dateFrom: Date | null;
  dateTo: Date | null;
  analysisModel: string | null;
  imageModel: string | null;
  aspectRatio: AspectRatio | null;
  styleId: string | null;
};

export type SortCriteria = {
  field: 'title' | 'createdAt' | 'analysisModel' | 'imageModel';
  direction: 'asc' | 'desc';
};

type EvalViewProps = {
  search: SequencesListSearch;
  prefs: SequencesListPrefs;
  setPrefs: (prefs: SequencesListPrefs) => void;
};

export const EvalView: React.FC<EvalViewProps> = ({
  search,
  prefs,
  setPrefs,
}) => {
  const [viewMode, setViewMode] = useState<ListViewMode>('gallery');
  const [sortCriteria, setSortCriteria] = useState<SortCriteria[]>([
    { field: 'createdAt', direction: 'desc' },
  ]);

  const filters: FilterState = useMemo(
    () => ({
      search: prefs.search,
      dateFrom: null,
      dateTo: null,
      analysisModel: prefs.analysisModel,
      imageModel: prefs.imageModel,
      aspectRatio: prefs.aspectRatio,
      styleId: prefs.styleId,
    }),
    [
      prefs.search,
      prefs.analysisModel,
      prefs.imageModel,
      prefs.aspectRatio,
      prefs.styleId,
    ]
  );

  const { data: adminStatus, isLoading: adminStatusLoading } = useQuery({
    queryKey: ['system-admin-status'],
    queryFn: () => isSystemAdminFn(),
    staleTime: 5 * 60 * 1000,
  });

  const isAdmin = adminStatus?.isAdmin ?? false;
  const internalDomains = useMemo(
    () => adminStatus?.internalDomains ?? [],
    [adminStatus?.internalDomains]
  );

  // Admin query is gated on isAdmin so a remembered `support=true` cannot 403
  // a non-admin. Stay in the loading skeleton until that check resolves.
  const supportMode = isAdmin && prefs.supportMode;
  const hideInternal = supportMode && prefs.hideInternal;

  const isMobile = useIsMobile();
  const loadShots = viewMode !== 'gallery';
  const ownData = useSequencesWithShots({
    enabled: !supportMode && !(prefs.supportMode && adminStatusLoading),
    loadShots,
  });
  const adminData = useAdminAllSequencesWithShots(
    supportMode,
    loadShots,
    supportMode ? filters.search : undefined
  );

  // Styles let search match a style's name and resolve ids → names for the
  // filter dropdown. The list covers the team's styles plus public ones.
  const { data: styles } = useStyles();
  const styleNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const style of styles ?? []) {
      map.set(style.id, style.name);
    }
    return map;
  }, [styles]);

  const sequences: SequenceWithShots[] = supportMode
    ? adminData.data
    : ownData.data;
  const isLoading =
    (prefs.supportMode && adminStatusLoading) ||
    (supportMode ? adminData.isLoading : ownData.isLoading);
  const shotsLoadingMap = supportMode
    ? adminData.shotsLoadingMap
    : ownData.shotsLoadingMap;
  const error = supportMode ? adminData.error : ownData.error;

  // Only offer styles that actually appear in the loaded sequences — listing
  // every team/public style would clutter the filter with options that match
  // nothing. Fall back to the raw styleId when a name isn't resolvable (e.g. a
  // cross-team style in support mode) so the option still filters correctly.
  const styleOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const seq of sequences) {
      if (!seq.styleId || seen.has(seq.styleId)) continue;
      seen.set(seq.styleId, styleNameById.get(seq.styleId) ?? seq.styleId);
    }
    const options = [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: 'all', label: 'All Styles' }, ...options];
  }, [sequences, styleNameById]);

  // Team-scoped divergence flags so own-data rows show a "variants available"
  // dot. In support mode rows belong to other teams, so the flag is irrelevant.
  const { data: divergentByTeam } = useTeamDivergentSequenceVariants(
    !supportMode && loadShots && sequences.length > 0
  );
  const divergenceMap = useMemo(() => {
    const map = new Map<string, { hasMusic: boolean }>();
    for (const row of divergentByTeam ?? []) {
      map.set(row.sequenceId, {
        hasMusic: row.hasMusic,
      });
    }
    return map;
  }, [divergentByTeam]);

  // Deep link wins: when a specific user is requested, never hide them.
  const effectiveHideInternal =
    hideInternal && !search.user && internalDomains.length > 0;

  // Client-side filtering for both modes. In support mode the server also
  // filters by search so this is a no-op; keeping it for own-data mode.
  const filteredAndSorted = useMemo(
    () =>
      applyFiltersAndSort(
        sequences,
        filters,
        sortCriteria,
        effectiveHideInternal ? internalDomains : [],
        styleNameById
      ),
    [
      sequences,
      filters,
      sortCriteria,
      effectiveHideInternal,
      internalDomains,
      styleNameById,
    ]
  );

  const handleLoadMore = supportMode
    ? () => {
        if (adminData.hasNextPage && !adminData.isFetchingNextPage) {
          void adminData.fetchNextPage();
        }
      }
    : undefined;

  return (
    <div className="flex-1 overflow-hidden flex flex-col gap-4">
      <EvalToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filters={filters}
        onFiltersChange={(next) =>
          setPrefs({
            search: next.search,
            analysisModel: next.analysisModel,
            imageModel: next.imageModel,
            aspectRatio: next.aspectRatio,
            styleId: next.styleId,
            supportMode: prefs.supportMode,
            hideInternal: prefs.hideInternal,
          })
        }
        styleOptions={styleOptions}
        sortCriteria={sortCriteria}
        onSortChange={setSortCriteria}
        supportMode={supportMode}
        isAdmin={isAdmin}
        onSupportModeChange={(value) =>
          setPrefs({
            ...prefs,
            supportMode: value,
            hideInternal: value ? prefs.hideInternal : false,
          })
        }
        hideInternal={hideInternal}
        onHideInternalChange={(value) =>
          setPrefs({ ...prefs, hideInternal: value })
        }
        hideInternalAvailable={internalDomains.length > 0}
        hideInternalLocked={Boolean(search.user)}
      />
      {error ? (
        <Card className="p-8 text-center" role="alert">
          <p className="text-destructive">
            Failed to load sequences: {error.message}
          </p>
        </Card>
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-5 overflow-hidden sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Card key={n} className="gap-3 p-0 pb-4">
              <Skeleton className="aspect-video w-full" />
              <div className="flex flex-col gap-2 px-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </Card>
          ))}
        </div>
      ) : filteredAndSorted.length === 0 ? (
        <EmptyState
          icon={<VideoIcon className="h-12 w-12" />}
          title={
            sequences.length > 0 || filters.search
              ? 'No matching sequences'
              : 'No sequences yet'
          }
          description={
            filters.search
              ? `No sequences match "${filters.search}".`
              : sequences.length > 0
                ? 'Try changing or clearing your filters.'
                : supportMode
                  ? 'No sequences found across any users.'
                  : 'Get started by creating your first video sequence. Transform your script into professional video content with AI assistance.'
          }
          action={
            !filters.search && !supportMode && sequences.length === 0 ? (
              <Button asChild size="lg">
                <Link to="/">Create Your First Sequence</Link>
              </Button>
            ) : undefined
          }
        />
      ) : viewMode === 'gallery' ? (
        <SequenceGallery
          sequences={filteredAndSorted}
          supportMode={supportMode}
          styleNameById={styleNameById}
        />
      ) : (
        <Suspense fallback={<Skeleton className="flex-1 min-h-64" />}>
          {isMobile ? (
            <EvalSequencesMobile
              sequences={filteredAndSorted}
              viewMode={viewMode}
              shotsLoadingMap={shotsLoadingMap}
              divergenceMap={divergenceMap}
            />
          ) : (
            <EvalMatrix
              sequences={filteredAndSorted}
              viewMode={viewMode}
              shotsLoadingMap={shotsLoadingMap}
              divergenceMap={divergenceMap}
            />
          )}
        </Suspense>
      )}
      {supportMode && adminData.hasNextPage && (
        <Button
          variant="outline"
          className="self-center shrink-0"
          onClick={handleLoadMore}
          disabled={adminData.isFetchingNextPage}
        >
          {adminData.isFetchingNextPage ? 'Loading…' : 'Load more sequences'}
        </Button>
      )}
      {/* Archived strip (#1108 Phase 4) — own-data only; renders nothing when
          the team has no archived sequences. */}
      {!supportMode && <ArchivedSequences />}
    </div>
  );
};

function applyFiltersAndSort(
  sequences: SequenceWithShots[],
  filters: FilterState,
  sortCriteria: SortCriteria[],
  hideDomains: string[],
  styleNameById: Map<string, string>
): SequenceWithShots[] {
  let result = [...sequences];

  if (hideDomains.length > 0) {
    const suffixes = hideDomains.map((d) => `@${d.toLowerCase()}`);
    result = result.filter((s) => {
      const { email } = getCreatorIdentity(s);
      if (!email) return true;
      const lowered = email.toLowerCase();
      return !suffixes.some((suffix) => lowered.endsWith(suffix));
    });
  }

  // Apply filters
  if (filters.search) {
    const searchLower = filters.search.toLowerCase();
    result = result.filter((s) => {
      if (s.title.toLowerCase().includes(searchLower)) return true;
      const styleName = s.styleId ? styleNameById.get(s.styleId) : undefined;
      if (styleName && styleName.toLowerCase().includes(searchLower))
        return true;
      const { name, email } = getCreatorIdentity(s);
      if (name && name.toLowerCase().includes(searchLower)) return true;
      if (email && email.toLowerCase().includes(searchLower)) return true;
      return false;
    });
  }

  const { dateFrom, dateTo } = filters;
  if (dateFrom) {
    result = result.filter((s) => new Date(s.createdAt) >= dateFrom);
  }

  if (dateTo) {
    result = result.filter((s) => new Date(s.createdAt) <= dateTo);
  }

  if (filters.analysisModel) {
    result = result.filter((s) => s.analysisModel === filters.analysisModel);
  }

  if (filters.imageModel) {
    result = result.filter((s) => s.imageModel === filters.imageModel);
  }

  if (filters.aspectRatio) {
    result = result.filter((s) => s.aspectRatio === filters.aspectRatio);
  }

  if (filters.styleId) {
    result = result.filter((s) => s.styleId === filters.styleId);
  }

  // Apply multi-criteria sort
  result.sort((a, b) => {
    for (const criteria of sortCriteria) {
      const aVal = a[criteria.field];
      const bVal = b[criteria.field];

      let cmp: number;
      if (criteria.field === 'createdAt') {
        const aTime = aVal ? new Date(aVal).getTime() : 0;
        const bTime = bVal ? new Date(bVal).getTime() : 0;
        cmp = aTime - bTime;
      } else {
        cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
      }

      if (cmp !== 0) {
        return criteria.direction === 'asc' ? cmp : -cmp;
      }
    }
    return 0;
  });

  return result;
}
