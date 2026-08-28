import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useUser } from '@/hooks/use-user';
import { useRealtime } from '@/lib/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { talentKeys } from './use-talent';
import {
  activityFromProgress,
  isSheetProgressStale,
  parseSheetProgressActivity,
  type SheetProgressActivity,
} from '@/lib/talent/sheet-progress-copy';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-talent-sheets-realtime']);

type InFlight = { activity: SheetProgressActivity; since: number };

type SheetProgressEvent = {
  event: string;
  data: {
    talentId: string;
    status: 'generating' | 'sheet_ready' | 'completed' | 'failed';
    activity?: SheetProgressActivity;
    sheetId?: string;
    sheetImageUrl?: string;
    headshotImageUrl?: string;
    error?: string;
  };
};

function readInFlight(value: unknown): InFlight | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (!('activity' in value) || !('since' in value)) return undefined;
  const activity = parseSheetProgressActivity(value.activity);
  if (!activity || typeof value.since !== 'number') return undefined;
  if (isSheetProgressStale(value.since)) return undefined;
  return { activity, since: value.since };
}

/**
 * Subscribe to talent-sheet generation for many ids (library grid).
 * History is reconciled on every id set change so a `completed` event we
 * missed (HMR, tab in background) cannot leave a tile spinning.
 */
export function useTalentSheetsRealtime(talentIds: string[] = []) {
  const queryClient = useQueryClient();
  const { data: user } = useUser();
  const [generatingStatus, setGeneratingStatus] = useState<
    Map<string, InFlight>
  >(new Map());

  const idKey = talentIds.join(',');
  const channels = useMemo(
    () =>
      idKey.length === 0 ? [] : idKey.split(',').map((id) => `talent:${id}`),
    [idKey]
  );

  useEffect(() => {
    const ids = idKey.length === 0 ? [] : idKey.split(',');
    if (!user || ids.length === 0) return;
    let cancelled = false;

    for (const id of ids) {
      void getChannelHistoryFn({ data: { channel: `talent:${id}` } })
        .then((events) => {
          if (cancelled) return;
          let last: {
            status: string;
            activity?: SheetProgressActivity;
            ts?: number;
          } | null = null;
          for (const evt of events) {
            if (evt.event !== 'talent.sheet:progress') continue;
            try {
              const parsed = JSON.parse(evt.data);
              if (parsed.talentId !== id) continue;
              last = { ...parsed, ts: evt.ts };
            } catch {
              // skip
            }
          }

          const inFlight =
            last &&
            (last.status === 'generating' || last.status === 'sheet_ready') &&
            !isSheetProgressStale(last.ts)
              ? {
                  activity: activityFromProgress(last),
                  since: last.ts ?? Date.now(),
                }
              : undefined;

          setGeneratingStatus((prev) => {
            const current = prev.get(id);
            if (!inFlight) {
              if (!current) return prev;
              const next = new Map(prev);
              next.delete(id);
              return next;
            }
            const next = new Map(prev);
            next.set(id, inFlight);
            return next;
          });
        })
        .catch((err: Error) => {
          logger.error(`Failed to fetch history for talent:${id}:`, { err });
        });
    }

    return () => {
      cancelled = true;
    };
  }, [idKey, user]);

  useEffect(() => {
    const tick = () => {
      setGeneratingStatus((prev) => {
        let changed = false;
        const next = new Map<string, InFlight>();
        for (const [id, value] of prev) {
          const entry = readInFlight(value);
          if (!entry) {
            changed = true;
            continue;
          }
          next.set(id, entry);
        }
        return changed ? next : prev;
      });
    };
    tick();
    const intervalId = window.setInterval(tick, 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const handleEvent = useCallback(
    (event: SheetProgressEvent) => {
      const { event: eventName, data } = event;

      if (eventName !== 'talent.sheet:progress') return;
      if (!talentIds.includes(data.talentId)) return;

      switch (data.status) {
        case 'generating':
        case 'sheet_ready':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.set(data.talentId, {
              activity: activityFromProgress(data),
              since: Date.now(),
            });
            return next;
          });
          if (data.status === 'sheet_ready') {
            void queryClient.invalidateQueries({
              queryKey: talentKeys.lists(),
            });
          }
          break;

        case 'completed':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.delete(data.talentId);
            return next;
          });
          void queryClient.invalidateQueries({
            queryKey: talentKeys.detail(data.talentId),
          });
          void queryClient.invalidateQueries({
            queryKey: talentKeys.lists(),
          });
          break;

        case 'failed':
          setGeneratingStatus((prev) => {
            const next = new Map(prev);
            next.delete(data.talentId);
            return next;
          });
          break;
      }
    },
    [talentIds, queryClient]
  );

  const { status } = useRealtime({
    channels,
    events: ['talent.sheet:progress'] as const,
    onData: handleEvent,
    enabled: talentIds.length > 0,
  });

  const isGenerating = useCallback(
    (talentId: string) => Boolean(readInFlight(generatingStatus.get(talentId))),
    [generatingStatus]
  );

  const generatingActivity = useCallback(
    (talentId: string) =>
      readInFlight(generatingStatus.get(talentId))?.activity,
    [generatingStatus]
  );

  return {
    isGenerating,
    generatingActivity,
    connectionStatus: status,
  };
}
