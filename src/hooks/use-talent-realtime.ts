import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useUser } from '@/hooks/use-user';
import { useRealtime } from '@/lib/realtime/client';
import type { StaleDetectedPayload } from '@/lib/realtime';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { talentKeys } from './use-talent';
import {
  activityFromProgress,
  isSheetProgressStale,
  SHEET_PROGRESS_STALE_MS,
  type SheetProgressActivity,
} from '@/lib/talent/sheet-progress-copy';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-talent-realtime']);

type GenerationPhase = SheetProgressActivity;

type SheetProgressData = {
  talentId: string;
  status: 'generating' | 'sheet_ready' | 'completed' | 'failed';
  activity?: SheetProgressActivity;
  sheetId?: string;
  sheetImageUrl?: string;
  headshotImageUrl?: string;
  error?: string;
};

// Discriminated by `event` so narrowing on the event name reaches the right
// branch. `StaleDetectedPayload` is the schema's discriminated union
// (z.discriminatedUnion('entityType', ...)), so `data.entityType` narrows to
// the literal — a hand-rolled `entityType: string` widening would defeat that
// and was the structural pattern behind the round-1 talent-channel routing bug.
type TalentRealtimeEvent =
  | { event: 'talent.sheet:progress'; data: SheetProgressData }
  | { event: 'generation.stale:detected'; data: StaleDetectedPayload };

/**
 * Determine the current generation state from a sequence of history events.
 * Returns the phase if generation is still in flight, null otherwise.
 */
function resolveStatusFromHistory(
  events: { event: string; data: string; ts?: number }[],
  talentId: string
): GenerationPhase | null {
  let last: {
    status: string;
    activity?: SheetProgressActivity;
    ts?: number;
  } | null = null;

  for (const evt of events) {
    if (evt.event !== 'talent.sheet:progress') continue;
    try {
      const parsed = JSON.parse(evt.data);
      if (parsed.talentId !== talentId) continue;
      last = { ...parsed, ts: evt.ts };
    } catch {
      // skip unparseable events
    }
  }

  if (!last) return null;
  if (last.status === 'generating' || last.status === 'sheet_ready') {
    if (isSheetProgressStale(last.ts)) return null;
    return activityFromProgress(last);
  }
  return null;
}

/**
 * Hook for subscribing to real-time talent sheet generation events.
 *
 * Replays channel history on mount so that in-flight generation is detected
 * even if the page was opened after the 'generating' event was emitted.
 *
 * @param talentId - The talent ID to subscribe to
 * @returns Generation status, current phase, and any error message
 */
export function useTalentSheetRealtime(talentId?: string) {
  const queryClient = useQueryClient();
  const { data: user } = useUser();
  const [isGenerating, setIsGenerating] = useState(false);
  const [phase, setPhase] = useState<GenerationPhase>('sheet');
  const [error, setError] = useState<string | null>(null);

  // Replay channel history on mount to catch in-flight generation
  useEffect(() => {
    if (!talentId || !user) return;

    getChannelHistoryFn({ data: { channel: `talent:${talentId}` } })
      .then((events) => {
        const historyPhase = resolveStatusFromHistory(events, talentId);
        if (historyPhase) {
          setIsGenerating(true);
          setPhase(historyPhase);
          setError(null);
          // If sheet is already ready, refresh data to show it
          if (historyPhase === 'portrait') {
            void queryClient.invalidateQueries({
              queryKey: talentKeys.detail(talentId),
            });
          }
        }
      })
      .catch((err: Error) => {
        logger.error(`Failed to fetch history for talent:${talentId}:`, {
          err,
        });
      });
  }, [talentId, queryClient, user]);

  useEffect(() => {
    if (!isGenerating) return;
    const timeoutId = window.setTimeout(() => {
      setIsGenerating(false);
      setError('Sheet generation took too long. Try Generate Sheet again.');
    }, SHEET_PROGRESS_STALE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isGenerating, phase]);

  const handleEvent = useCallback(
    (event: TalentRealtimeEvent) => {
      if (event.event === 'generation.stale:detected') {
        if (event.data.entityType !== 'talent') return;
        // Divergent talent sheet was parked in `talent_sheet_variants`. The
        // workflow already emitted `talent.sheet:progress` with status
        // `completed` against the new variant sheet, so the spinner clears
        // through that path. Refresh the talent detail/list so the new
        // (non-default) sheet appears in the sheets list.
        if (talentId) {
          void queryClient.invalidateQueries({
            queryKey: talentKeys.detail(talentId),
          });
        }
        void queryClient.invalidateQueries({
          queryKey: talentKeys.lists(),
        });
        return;
      }

      // Defensive narrow — discriminated union currently has 2 arms, this guards adding a 3rd.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (event.event !== 'talent.sheet:progress') return;
      const sheetData = event.data;
      if (sheetData.talentId !== talentId) return;

      switch (sheetData.status) {
        case 'generating':
          setIsGenerating(true);
          setPhase(activityFromProgress(sheetData));
          setError(null);
          break;

        case 'sheet_ready':
          // Sheet is done, now generating portrait headshot
          setPhase('portrait');
          // Invalidate to show the new sheet immediately
          void queryClient.invalidateQueries({
            queryKey: talentKeys.detail(sheetData.talentId),
          });
          break;

        case 'completed':
          setIsGenerating(false);
          setPhase('sheet');
          setError(null);
          // Invalidate talent queries to refresh sheets and headshot
          void queryClient.invalidateQueries({
            queryKey: talentKeys.detail(sheetData.talentId),
          });
          // Also invalidate list to show new headshot in talent grid
          void queryClient.invalidateQueries({
            queryKey: talentKeys.lists(),
          });
          break;

        case 'failed':
          setIsGenerating(false);
          setError(sheetData.error ?? 'Sheet generation failed');
          break;
      }
    },
    [talentId, queryClient]
  );

  const { status } = useRealtime({
    channels: talentId ? [`talent:${talentId}`] : [],
    events: ['talent.sheet:progress', 'generation.stale:detected'] as const,
    onData: handleEvent,
    enabled: !!talentId,
  });

  // Allow starting generation optimistically (before realtime event arrives)
  const startGenerating = useCallback(
    (activity: SheetProgressActivity = 'sheet') => {
      setIsGenerating(true);
      setPhase(activity);
      setError(null);
    },
    []
  );

  const stopGenerating = useCallback((message?: string) => {
    setIsGenerating(false);
    if (message) setError(message);
  }, []);

  return {
    isGenerating,
    phase,
    error,
    connectionStatus: status,
    startGenerating,
    stopGenerating,
  };
}
