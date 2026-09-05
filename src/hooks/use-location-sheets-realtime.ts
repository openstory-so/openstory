import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useUser } from '@/hooks/use-user';
import { useRealtime } from '@/shared/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { locationLibraryKeys } from './use-location-library';
import { libraryLocationKeys } from './use-sequence-locations';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-location-sheets-realtime']);

type SheetProgressEvent = {
  event: string;
  data: {
    locationId: string;
    status: 'generating' | 'completed' | 'failed';
    sheetImageUrl?: string;
    error?: string;
  };
};

/**
 * Hook for subscribing to real-time location sheet generation events for multiple locations.
 * Replays channel history on mount for each location to catch in-flight generations.
 */
export function useLocationSheetsRealtime(locationIds: string[] = []) {
  const queryClient = useQueryClient();
  const { data: user } = useUser();
  const [generatingStatus, setGeneratingStatus] = useState<
    Map<string, boolean>
  >(new Map());

  const checkedIds = useRef(new Set<string>());

  const channels = useMemo(
    () => locationIds.map((id) => `location:${id}`),
    [locationIds]
  );

  // Replay channel history for newly added location IDs
  useEffect(() => {
    if (!user) return;

    const newIds = locationIds.filter((id) => !checkedIds.current.has(id));
    if (newIds.length === 0) return;

    for (const id of newIds) {
      checkedIds.current.add(id);

      getChannelHistoryFn({ data: { channel: `location:${id}` } })
        .then((events) => {
          let lastStatus: string | null = null;
          for (const evt of events) {
            if (evt.event !== 'location.sheet:progress') continue;
            try {
              const parsed = JSON.parse(evt.data);
              if (parsed.locationId !== id) continue;
              lastStatus = parsed.status;
            } catch {
              // skip
            }
          }

          if (lastStatus === 'generating') {
            setGeneratingStatus((prev) => {
              const next = new Map(prev);
              next.set(id, true);
              return next;
            });
          }
        })
        .catch((err: Error) => {
          logger.error(`Failed to fetch history for location:${id}:`, { err });
        });
    }
  }, [locationIds, user]);

  const handleEvent = useCallback(
    (event: SheetProgressEvent) => {
      const { event: eventName, data } = event;

      if (eventName !== 'location.sheet:progress') return;
      if (!locationIds.includes(data.locationId)) return;

      switch (data.status) {
        case 'generating':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.set(data.locationId, true);
            return next;
          });
          break;

        case 'completed':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.delete(data.locationId);
            return next;
          });
          void queryClient.invalidateQueries({
            queryKey: locationLibraryKeys.detail(data.locationId),
          });
          void queryClient.invalidateQueries({
            queryKey: libraryLocationKeys.all,
          });
          break;

        case 'failed':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.delete(data.locationId);
            return next;
          });
          break;
      }
    },
    [locationIds, queryClient]
  );

  const { status } = useRealtime({
    channels,
    events: ['location.sheet:progress'] as const,
    onData: handleEvent,
    enabled: locationIds.length > 0,
  });

  const isGenerating = useCallback(
    (locationId: string) => generatingStatus.get(locationId) ?? false,
    [generatingStatus]
  );

  return {
    isGenerating,
    connectionStatus: status,
  };
}
