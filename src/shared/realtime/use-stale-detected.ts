import { shotKeys } from '@/hooks/use-shots';
import type { StaleDetectedPayload } from '@/shared/realtime';
import { useRealtime } from '@/shared/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'realtime', 'use-stale-detected']);

const TOAST_DEBOUNCE_MS = 5_000;

/**
 * Format the debounced "alternates available" toast message.
 * Exported for unit testing (the hook itself is not directly testable
 * without a DOM environment).
 */
export function formatStaleToastMessage(count: number): string {
  return count === 1
    ? 'An alternate version is available.'
    : `${count} alternate versions are available.`;
}

// Bind to the schema's discriminated union so `data.entityType` narrows to a
// literal — a hand-rolled `entityType: string` defeats branch narrowing and
// was the structural pattern behind the round-1 talent-channel routing bug.
type StaleDetectedEvent = {
  event: 'generation.stale:detected';
  data: StaleDetectedPayload;
};

type DebounceState = {
  count: number;
  timeout: ReturnType<typeof setTimeout> | null;
};

/**
 * Subscribes to `generation.stale:detected` for the current sequence channel.
 *
 * Two responsibilities:
 *  1. Show a sonner toast announcing the alternate. Debounced to one toast
 *     per sequence per 5s with a count, so a recast that lands many divergent
 *     variants in quick succession doesn't spam the user.
 *  2. Invalidate TanStack Query caches so the divergent banner / corner dot
 *     appear inline without a manual refresh.
 *
 * Returns nothing — this is a fire-and-forget subscription kept alive for the
 * scenes view's lifetime.
 */
export function useStaleDetected(sequenceId: string | undefined) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<DebounceState>({ count: 0, timeout: null });

  // Track the sequenceId the timer was scheduled for so a navigation within
  // the 5s debounce window cannot credit late-arriving events to the wrong
  // sequence's toast.
  const handleEvent = useCallback(
    (event: StaleDetectedEvent) => {
      // Defensive: subscription is bound to this event but kept narrow for safety if more event types are added.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (event.event !== 'generation.stale:detected') return;
      if (!sequenceId) return;
      const scheduledFor = sequenceId;

      void queryClient.invalidateQueries({
        queryKey: shotKeys.list(sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: shotKeys.divergentVariants(sequenceId),
      });

      const state = debounceRef.current;
      state.count += 1;
      if (state.timeout) return;
      state.timeout = setTimeout(() => {
        const count = state.count;
        state.count = 0;
        state.timeout = null;
        // Bail if the user navigated away while the timer was pending — the
        // count belongs to the previous sequence and the new view will get
        // its own subscription + toast.
        if (scheduledFor !== sequenceIdRef.current) return;
        toast.info(formatStaleToastMessage(count));
      }, TOAST_DEBOUNCE_MS);
    },
    [queryClient, sequenceId]
  );

  const sequenceIdRef = useRef(sequenceId);
  useEffect(() => {
    sequenceIdRef.current = sequenceId;
  }, [sequenceId]);

  const { status } = useRealtime({
    channels: sequenceId ? [sequenceId] : [],
    events: ['generation.stale:detected'] as const,
    onData: handleEvent,
    enabled: !!sequenceId,
  });

  // Surface realtime subscription failures so silent disconnects show up in
  // logs — without this the divergent banner can stay stale forever with no
  // signal. Polling fallback in `useDivergentVariants` covers UX recovery.
  useEffect(() => {
    if (!sequenceId) return;
    if (status === 'error') {
      logger.error('realtime channel error', {
        sequenceId,
      });
    }
  }, [status, sequenceId]);

  // Cancel any pending toast when the sequence changes or the view unmounts —
  // otherwise a navigation within the 5s debounce window fires a toast for a
  // sequence the user has already left.
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
