import type React from 'react';
import { useMemo, useState } from 'react';
import { ArchivedSequences } from '@/components/sequence/archived-sequences';
import { EvalToolbar } from './eval-toolbar';
import { EvalMatrix } from './eval-matrix';
import { EvalSequencesMobile } from './eval-sequences-mobile';
import {
  useSequencesWithShots,
  type SequenceWithShots,
} from '@/hooks/use-sequences-with-shots';
import { useAdminAllSequencesWithShots } from '@/hooks/use-admin-support';
import { useTeamDivergentSequenceVariants } from '@/hooks/use-sequence-variants';
import { useStyles } from '@/hooks/use-styles';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { VideoIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type {
  SequencesListPrefs,
  SequencesListSearch,
} from '@/lib/sequences/list-prefs';
import { getCreatorIdentity } from './creator-identity';

export type ViewMode = 'script' | 'prompts' | 'images' | 'motion';

export function isValidViewMode(value: string): value is ViewMode {
  return (
    value === 'script' ||
    value === 'prompts' ||
    value === 'images' ||
    value === 'motion'
  );
}

export function isValidSortField(
  value: string
): value is SortCriteria['field'] {
  return (
    value === 'title' ||
    value === 'createdAt' ||
    value === 'analysisModel' ||
    value === 'imageModel'
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
  const [viewMode, setViewMode] = useState<ViewMode>('prompts');
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

  const ownData = useSequencesWithShots();
  const adminData = useAdminAllSequencesWithShots(
    supportMode,
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
    !supportMode && sequences.length > 0
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

  if (error) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col gap-4">
        <Card className="p-8 text-center">
          <p className="text-destructive">
            Failed to load sequences: {error.message}
          </p>
        </Card>
      </div>
    );
  }

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
      {isLoading ? (
        <Card className="flex-1 p-4">
          <div className="space-y-4">
            {[1, 2, 3].map((n) => (
              <div key={`skeleton-${n}`} className="flex gap-4">
                <Skeleton className="h-24 w-64" />
                <Skeleton className="h-24 w-48" />
                <Skeleton className="h-24 w-48" />
                <Skeleton className="h-24 w-48" />
              </div>
            ))}
          </div>
        </Card>
      ) : filteredAndSorted.length === 0 ? (
        <EmptyState
          icon={<VideoIcon className="h-12 w-12" />}
          title={filters.search ? 'No matching sequences' : 'No sequences yet'}
          description={
            filters.search
              ? `No sequences match "${filters.search}".`
              : supportMode
                ? 'No sequences found across any users.'
                : 'Get started by creating your first video sequence. Transform your script into professional video content with AI assistance.'
          }
          action={
            !filters.search && !supportMode ? (
              <Button asChild size="lg">
                <Link to="/">Create Your First Sequence</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex-1 min-h-0 flex flex-col sm:hidden">
            <EvalSequencesMobile
              sequences={filteredAndSorted}
              viewMode={viewMode}
              shotsLoadingMap={shotsLoadingMap}
              divergenceMap={divergenceMap}
              onLoadMore={handleLoadMore}
              hasMore={supportMode ? adminData.hasNextPage : false}
            />
          </div>
          <div className="flex-1 min-h-0 hidden sm:flex sm:flex-col">
            <EvalMatrix
              sequences={filteredAndSorted}
              viewMode={viewMode}
              shotsLoadingMap={shotsLoadingMap}
              divergenceMap={divergenceMap}
              onLoadMore={handleLoadMore}
              hasMore={supportMode ? adminData.hasNextPage : false}
            />
          </div>
        </>
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
