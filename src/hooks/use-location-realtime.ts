import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useUser } from '@/hooks/use-user';
import { useRealtime } from '@/components/realtime/client';
import type { StaleDetectedPayload } from '@/shared/realtime';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { locationLibraryKeys } from './use-location-library';
import { libraryLocationKeys } from './use-sequence-locations';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-location-realtime']);

type SheetProgressData = {
  locationId: string;
  status: 'generating' | 'completed' | 'failed';
  sheetImageUrl?: string;
  error?: string;
};

// Discriminated by `event` so narrowing on the event name reaches the right
// branch. `StaleDetectedPayload` is the schema's discriminated union, so
// `data.entityType` narrows to the literal — see use-talent-realtime.ts.
type LocationRealtimeEvent =
  | { event: 'location.sheet:progress'; data: SheetProgressData }
  | { event: 'generation.stale:detected'; data: StaleDetectedPayload };

/**
 * Determine the current generation state from channel history.
 */
function resolveStatusFromHistory(
  events: { event: string; data: string }[],
  locationId: string
): 'generating' | null {
  let lastStatus: string | null = null;

  for (const evt of events) {
    if (evt.event !== 'location.sheet:progress') continue;
    try {
      const parsed = JSON.parse(evt.data);
      if (parsed.locationId !== locationId) continue;
      lastStatus = parsed.status;
    } catch {
      // skip
    }
  }

  return lastStatus === 'generating' ? 'generating' : null;
}

/**
 * Hook for subscribing to real-time location sheet generation events.
 * Replays channel history on mount to catch in-flight generation.
 */
export function useLocationSheetRealtime(locationId?: string) {
  const queryClient = useQueryClient();
  const { data: user } = useUser();
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Replay channel history on mount
  useEffect(() => {
    if (!locationId || !user) return;

    getChannelHistoryFn({ data: { channel: `location:${locationId}` } })
      .then((events) => {
        if (resolveStatusFromHistory(events, locationId) === 'generating') {
          setIsGenerating(true);
          setError(null);
        }
      })
      .catch((err: Error) => {
        logger.error(`Failed to fetch history for location:${locationId}:`, {
          err,
        });
      });
  }, [locationId, user]);

  const handleEvent = useCallback(
    (event: LocationRealtimeEvent) => {
      if (event.event === 'generation.stale:detected') {
        if (event.data.entityType !== 'library-location') return;
        // Library-location reference diverged into `location_sheet_variants`.
        // The library row's primary reference is unchanged. Refetch detail
        // and list so any variant-surfacing UI picks up the new alternate.
        if (locationId) {
          void queryClient.invalidateQueries({
            queryKey: locationLibraryKeys.detail(locationId),
          });
        }
        void queryClient.invalidateQueries({
          queryKey: libraryLocationKeys.all,
        });
        return;
      }

      // Defensive narrow — discriminated union currently has 2 arms, this guards adding a 3rd.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (event.event !== 'location.sheet:progress') return;
      const sheetData = event.data;
      if (sheetData.locationId !== locationId) return;

      switch (sheetData.status) {
        case 'generating':
          setIsGenerating(true);
          setError(null);
          break;

        case 'completed':
          setIsGenerating(false);
          setError(null);
          if (locationId) {
            void queryClient.invalidateQueries({
              queryKey: locationLibraryKeys.detail(locationId),
            });
          }
          void queryClient.invalidateQueries({
            queryKey: libraryLocationKeys.all,
          });
          break;

        case 'failed':
          setIsGenerating(false);
          setError(sheetData.error ?? 'Sheet generation failed');
          break;
      }
    },
    [locationId, queryClient]
  );

  const { status } = useRealtime({
    channels: locationId ? [`location:${locationId}`] : [],
    events: ['location.sheet:progress', 'generation.stale:detected'] as const,
    onData: handleEvent,
    enabled: !!locationId,
  });

  const startGenerating = useCallback(() => {
    setIsGenerating(true);
    setError(null);
  }, []);

  return {
    isGenerating,
    error,
    connectionStatus: status,
    startGenerating,
  };
}
