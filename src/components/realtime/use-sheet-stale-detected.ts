import { useRealtime } from '@/components/realtime/client';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'realtime', 'use-sheet-stale-detected']);

const TOAST_DEBOUNCE_MS = 5_000;

export function formatSheetStaleToastMessage(count: number): string {
  return count === 1
    ? 'An alternate version is available.'
    : `${count} alternate versions are available.`;
}

type SheetStaleDetectedOptions = {
  /**
   * Resolved realtime channel id. Sequence channels use the bare sequence id;
   * talent / library-location channels use the prefixed forms (`talent:${id}`,
   * `location:${id}`) — see `getTalentChannel` / `getLocationChannel` in
   * `src/shared/realtime.ts`.
   */
  channelId: string | undefined;
  /**
   * Filter so the hook only reacts to events whose `entityType` matches one
   * of the values in this list. Avoids cross-talk when several entity types
   * share a sequence channel (shot + character + location all emit there).
   */
  entityTypes: ReadonlyArray<
    'shot' | 'character' | 'location' | 'library-location' | 'talent'
  >;
  /**
   * Query keys to invalidate when a matching stale:detected event arrives.
   * Caller decides which divergent-variant queries should refetch.
   */
  invalidateKeys: () => QueryKey[];
};

type StaleDetectedEvent = {
  event: string;
  data: {
    entityType: string;
    entityId: string;
    artifact?: string;
    snapshotInputHash: string;
    divergedVariantId?: string;
  };
};

export function useSheetStaleDetected({
  channelId,
  entityTypes,
  invalidateKeys,
}: SheetStaleDetectedOptions) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<{
    count: number;
    timeout: ReturnType<typeof setTimeout> | null;
  }>({ count: 0, timeout: null });

  // Track the channel the timer was scheduled for so a navigation within
  // the 5s debounce window cannot credit late-arriving events to the
  // wrong channel's toast.
  const channelIdRef = useRef(channelId);
  useEffect(() => {
    channelIdRef.current = channelId;
  }, [channelId]);

  // Keep the entity-type allowlist + invalidate-keys callback in refs so the
  // memoised event handler doesn't re-create on every render.
  const entityTypesRef = useRef(entityTypes);
  useEffect(() => {
    entityTypesRef.current = entityTypes;
  }, [entityTypes]);

  const invalidateKeysRef = useRef(invalidateKeys);
  useEffect(() => {
    invalidateKeysRef.current = invalidateKeys;
  }, [invalidateKeys]);

  const errorToastShownForRef = useRef<string | null>(null);

  const handleEvent = useCallback(
    (event: StaleDetectedEvent) => {
      if (event.event !== 'generation.stale:detected') return;
      if (!channelId) return;
      const allowedTypes: ReadonlyArray<string> = entityTypesRef.current;
      if (!allowedTypes.includes(event.data.entityType)) {
        return;
      }
      const scheduledFor = channelId;

      for (const key of invalidateKeysRef.current()) {
        void queryClient.invalidateQueries({ queryKey: key });
      }

      const state = debounceRef.current;
      state.count += 1;
      if (state.timeout) return;
      state.timeout = setTimeout(() => {
        const count = state.count;
        state.count = 0;
        state.timeout = null;
        if (scheduledFor !== channelIdRef.current) return;
        toast.info(formatSheetStaleToastMessage(count));
      }, TOAST_DEBOUNCE_MS);
    },
    [queryClient, channelId]
  );

  const { status } = useRealtime({
    channels: channelId ? [channelId] : [],
    events: ['generation.stale:detected'] as const,
    onData: handleEvent,
    enabled: !!channelId,
  });

  useEffect(() => {
    if (!channelId) return;
    if (status === 'error') {
      logger.error('realtime channel error', {
        channelId,
      });
      if (errorToastShownForRef.current !== channelId) {
        errorToastShownForRef.current = channelId;
        toast.warning(
          'Live updates disconnected — refresh to see latest alternates.'
        );
      }
    } else if (status === 'connected' && errorToastShownForRef.current) {
      errorToastShownForRef.current = null;
    }
  }, [status, channelId]);

  // Cancel any pending toast when the channel changes or the view unmounts.
  useEffect(() => {
    const state = debounceRef.current;
    return () => {
      if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
        state.count = 0;
      }
    };
  }, [channelId]);
}
