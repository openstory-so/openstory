import { getSequenceSegmentsFn } from '@/shots/segments.fn';
import type { SequenceSegment } from '@/shots/scene-segments';
import { useSequenceReady } from '@/sequences/ui/pending-sequence-create';
import { useQuery } from '@tanstack/react-query';

export const segmentKeys = {
  all: ['segments'] as const,
  list: (sequenceId: string) =>
    [...segmentKeys.all, 'list', sequenceId] as const,
};

/**
 * Every render segment in a sequence with its video versions + selection + stale
 * flag (#986 / #990). The Scenes shot-strip lane and the segment-aware Video tab
 * both read this; membership is joined against already-loaded shots client-side.
 */
export function useSequenceSegments(
  sequenceId?: string,
  options?: { refetchInterval?: number | false }
) {
  const ready = useSequenceReady(sequenceId);
  return useQuery<SequenceSegment[]>({
    queryKey: segmentKeys.list(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceSegmentsFn({ data: { sequenceId } });
    },
    enabled: ready,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}
