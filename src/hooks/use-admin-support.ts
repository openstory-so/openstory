import { useMemo } from 'react';
import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import {
  getAdminShotsFn,
  getAllAdminSequencesFn,
} from '@/functions/admin-support';
import type { SequenceWithShots } from './use-sequences-with-shots';
import type { Sequence } from '@/types/database';
import type { ShotView } from '@/shared/shots/shot-view';

const PAGE_SIZE = 50;

const adminSupportKeys = {
  all: ['admin-support'] as const,
  sequences: (search?: string) =>
    [...adminSupportKeys.all, 'sequences', search ?? ''] as const,
  shots: (sequenceId: string) =>
    [...adminSupportKeys.all, 'shots', sequenceId] as const,
};

export type AdminSequenceWithShots = SequenceWithShots & {
  creatorName: string | null;
  creatorEmail: string | null;
};

export function useAdminAllSequencesWithShots(
  enabled: boolean,
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
    staleTime: 60_000,
  });

  const allSequences = useMemo(
    () => infiniteData?.pages.flat() ?? [],
    [infiniteData]
  );

  const shotsQueries = useQueries({
    queries: allSequences.map((seq: Sequence) => ({
      queryKey: adminSupportKeys.shots(seq.id),
      queryFn: async (): Promise<ShotView[]> => {
        return getAdminShotsFn({ data: { sequenceId: seq.id } });
      },
      staleTime: 60_000,
      enabled: allSequences.length > 0,
    })),
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
