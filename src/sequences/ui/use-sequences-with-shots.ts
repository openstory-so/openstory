import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSequences } from './use-sequences';
import { getShotsForSequencesFn } from '@/shots/shots.fn';
import type { Sequence } from '@/platform/server/db/schema';
import type { ShotView } from '@/shots/shot-view';

export type SequenceWithShots = Sequence & {
  shots: ShotView[];
  // Present only when fetched via the admin/support endpoint. Optional on the
  // base type so components render a single CreatorIdentity regardless of source.
  creatorName?: string | null;
  creatorEmail?: string | null;
};

/** Only fetch shot details when a comparison view is open. */
export function useSequencesWithShots({
  enabled = true,
  loadShots = true,
}: { enabled?: boolean; loadShots?: boolean } = {}) {
  const {
    data: sequences,
    isLoading: seqLoading,
    error: seqError,
  } = useSequences(undefined, { enabled });

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
    enabled: enabled && loadShots && sequenceIds.length > 0,
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

  const error = seqError || (loadShots ? shotsError : null);

  return {
    data,
    isLoading: seqLoading,
    shotsLoadingMap,
    error,
  };
}
