import { sequenceKeys } from '@/hooks/use-sequences';
import { sequenceVariantKeys } from '@/hooks/use-sequence-variants';
import type { StaleDetectedPayload } from '@/shared/realtime';
import { useRealtime } from '@/components/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger([
  'openstory',
  'realtime',
  'use-sequence-stale-detected',
]);

const TOAST_DEBOUNCE_MS = 5_000;

/**
 * Format the debounced "alternate music tracks available" toast for
 * sequence-level music divergence. Exported for unit testing.
 */
export function formatSequenceStaleToastMessage(count: number): string {
  if (count === 1) {
    return 'An alternate music track is available.';
  }
  return `${count} alternate music tracks are available.`;
}

// Bind to the schema's discriminated union so `data.entityType` narrows to a
// literal and `data.artifact` narrows per branch.
type StaleDetectedEvent = {
  event: 'generation.stale:detected';
  data: StaleDetectedPayload;
};

type DebounceState = {
  count: number;
  timeout: ReturnType<typeof setTimeout> | null;
};

/**
 * Subscribes to `generation.stale:detected` filtered for sequence-scoped
 * music divergence. Mirrors `useStaleDetected` for shots:
 *  1. Show a debounced sonner toast (5 s window, count).
 *  2. Invalidate the matching `sequenceVariantKeys.divergentMusic` query so
 *     the inline banner appears without a manual refresh.
 */
export function useSequenceStaleDetected(sequenceId: string | undefined) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<DebounceState>({
    count: 0,
    timeout: null,
  });

  const sequenceIdRef = useRef(sequenceId);
  useEffect(() => {
    sequenceIdRef.current = sequenceId;
  }, [sequenceId]);

  const handleEvent = useCallback(
    (event: StaleDetectedEvent) => {
      // Defensive narrow — discriminated union currently has 1 arm, this guards adding more.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (event.event !== 'generation.stale:detected') return;
      if (!sequenceId) return;
      if (event.data.entityType !== 'sequence') return;
      const scheduledFor = sequenceId;

      void queryClient.invalidateQueries({
        queryKey: sequenceVariantKeys.divergentMusic(sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });

      const state = debounceRef.current;
      state.count += 1;
      if (state.timeout) return;
      state.timeout = setTimeout(() => {
        const count = state.count;
        state.count = 0;
        state.timeout = null;
        if (scheduledFor !== sequenceIdRef.current) return;
        toast.info(formatSequenceStaleToastMessage(count));
      }, TOAST_DEBOUNCE_MS);
    },
    [queryClient, sequenceId]
  );

  const { status } = useRealtime({
    channels: sequenceId ? [sequenceId] : [],
    events: ['generation.stale:detected'] as const,
    onData: handleEvent,
    enabled: !!sequenceId,
  });

  // Surface realtime subscription failures so silent disconnects show up in
  // logs — without this the divergent banner can stay stale forever with no
  // signal. Polling fallback in `useSequenceDivergentMusicVariants` covers UX
  // recovery.
  useEffect(() => {
    if (!sequenceId) return;
    if (status === 'error') {
      logger.error('realtime channel error', {
        sequenceId,
      });
    }
  }, [status, sequenceId]);

  // Cancel any pending toast on unmount or sequence change so a navigation
  // within the 5 s debounce window doesn't fire a toast for a sequence the
  // user has already left.
  useEffect(() => {
    const state = debounceRef.current;
    return () => {
      if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
        state.count = 0;
      }
    };
  }, [sequenceId]);
}
