import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSequences } from './use-sequences';
import { getShotsForSequencesFn } from '@/functions/shots';
import type { Sequence } from '@/types/database';
import type { ShotView } from '@/shared/shots/shot-view';

export type SequenceWithShots = Sequence & {
  shots: ShotView[];
  // Present only when fetched via the admin/support endpoint. Optional on the
  // base type so components render a single CreatorIdentity regardless of source.
  creatorName?: string | null;
  creatorEmail?: string | null;
};

/**
 * Fetches all sequences and their shots. Previously this fanned out one
 * `getShotsFn` per sequence via `useQueries`, which crashed iOS Chrome's
 * WebProcess once teams accumulated ~50+ sequences (the parallel server-fn
 * round-trips saturated the connection pool — see the
 * `claude/mobile-sequence-navigation-dmLJn` branch history for the wrangler
 * tail). Now one batched call returns every shot, grouped client-side.
 */
export function useSequencesWithShots() {
  const {
    data: sequences,
    isLoading: seqLoading,
    error: seqError,
  } = useSequences();

  const sequenceIds = useMemo(
    () => (sequences ?? []).map((s) => s.id),
    [sequences]
  );

  const {
    data: shotsBySequenceId,
    isLoading: shotsLoading,
    error: shotsError,
  } = useQuery({
    queryKey: ['shots', 'by-sequences', [...sequenceIds].sort()],
    queryFn: async (): Promise<Map<string, ShotView[]>> => {
      if (sequenceIds.length === 0) return new Map();
      const allShots = await getShotsForSequencesFn({
        data: { sequenceIds },
      });
      const map = new Map<string, ShotView[]>();
      for (const shot of allShots) {
        const existing = map.get(shot.sequenceId) ?? [];
        existing.push(shot);
        map.set(shot.sequenceId, existing);
      }
      return map;
    },
    enabled: sequenceIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const data = useMemo<SequenceWithShots[]>(() => {
    if (!sequences) return [];
    return sequences.map((seq) => ({
      ...seq,
      shots: shotsBySequenceId?.get(seq.id) ?? [],
    }));
  }, [sequences, shotsBySequenceId]);

  // Single batch query means a single in-flight signal — every row reflects
  // it identically. Kept as a per-id map so callers (EvalSequencesMobile,
  // EvalMatrix) can render row-level skeletons without a behavior change.
  const shotsLoadingMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const seq of sequences ?? []) {
      map[seq.id] = shotsLoading;
    }
    return map;
  }, [sequences, shotsLoading]);

  const error = seqError || shotsError;

  return {
    data,
    isLoading: seqLoading,
    shotsLoadingMap,
    error,
  };
}
