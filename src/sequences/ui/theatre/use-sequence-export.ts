/**
 * On-demand sequence export. Download/Copy reuse a ready row whose
 * `sourceShotsHash` matches the current cut; otherwise they POST
 * `/api/v1/sequences/$id/exports` and poll. There is no in-browser encode.
 *
 * Theatre playback does not wait on an export (#1623): it plays a playlist
 * that points straight at the clips. See `playbackUrl`.
 */

import {
  isServerExportAvailableFn,
  listSequenceExportsFn,
} from '@/sequences/sequence-exports.fn';
import { useShotsBySequence } from '@/shots/ui/use-shots';
import {
  collapseConsecutiveUrls,
  scenePlaybackKey,
  toPlaybackScenes,
} from './playback-scenes';
import {
  effectiveExportMusicUrl,
  hashSequenceExportInputs,
  sequenceExportInputsKey,
} from './source-shots-hash';
import { exportSequenceOnServer } from './server-export-client';
import { captureVideoPlayFailed } from './player-events';
import type { Sequence } from '@/platform/server/db/schema';
import { copyTextToClipboard } from '@/ui/clipboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePostHog } from '@posthog/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

const sequenceExportKeys = {
  list: (sequenceId: string) => ['sequence-exports', sequenceId] as const,
  serverAvailable: ['server-export-available'] as const,
};

const CONTAINER_MISSING_MESSAGE =
  'Export needs the video renderer. Run bun dev:all, or set VIDEO_EXPORT_DEV_URL.';

type SequenceExportAndThen = 'download' | 'copy-link';

export type ExportProgress = {
  phase: 'server';
  completed: number;
  total: number;
};

export type SequenceExportState = {
  isRunning: boolean;
  progress: ExportProgress | null;
  /** Cached export URL for the current scenes + music choice, or null. */
  freshExportUrl: string | null;
  /**
   * What the theatre plays: the playlist of the clips that exist right now
   * (`theatre-playlist.ts`). Asked for as soon as the shots are known, not on
   * the click, so a first visit's one-time repackaging is usually done before
   * anyone presses play. `undefined` = still finding out — show the first
   * frame, don't stitch yet. `null` = the server could not list these clips:
   * stitch in the tab.
   */
  playbackUrl: string | null | undefined;
  /** Download the current state's MP4 — exports first if not cached. */
  download: () => void;
  /** Copy a shareable URL for the current state's MP4 — exports first if not cached. */
  copyLink: () => void;
  abort: () => void;
  clipsReady: number;
  clipsTotal: number;
  /** False until every shot has a clip. */
  canExport: boolean;
};

export function useSequenceExport(
  sequence: Sequence | undefined
): SequenceExportState {
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const sequenceId = sequence?.id ?? '';
  const { data: shots } = useShotsBySequence(sequence?.id);

  const { data: exports } = useQuery({
    queryKey: sequenceExportKeys.list(sequenceId),
    queryFn: () => listSequenceExportsFn({ data: { sequenceId } }),
    staleTime: 5_000,
    enabled: Boolean(sequence),
  });

  const exportInputs = useMemo(() => {
    if (!sequence || !shots) return null;
    const sceneUrls: string[] = [];
    for (const shot of shots) {
      const url = shot.video?.url;
      if (!url) return null;
      sceneUrls.push(url);
    }
    if (sceneUrls.length === 0) return null;
    return {
      sceneUrls: collapseConsecutiveUrls(sceneUrls),
      musicUrl: effectiveExportMusicUrl(
        sequence.includeMusic,
        sequence.musicUrl
      ),
    };
  }, [sequence, shots]);
  const inputsKey = exportInputs ? sequenceExportInputsKey(exportInputs) : null;
  const { data: inputsHash, error: inputsHashError } = useQuery({
    queryKey: ['sequence-export-inputs-hash', inputsKey],
    queryFn: () => {
      if (!exportInputs) {
        throw new Error('Could not fingerprint the scenes for export.');
      }
      return hashSequenceExportInputs(exportInputs);
    },
    enabled: exportInputs !== null,
    staleTime: Infinity,
    retry: false,
  });

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const exportMutation = useMutation({
    mutationFn: async ({
      signal,
      andThen,
    }: {
      signal: AbortSignal;
      andThen: SequenceExportAndThen;
    }) => {
      if (!sequence) throw new Error('No sequence selected.');
      if (!shots || shots.length === 0) {
        throw new Error('This sequence has no shots yet.');
      }
      const ready = shots.filter((s) => Boolean(s.video?.url)).length;
      if (ready !== shots.length) {
        throw new Error(
          `${shots.length - ready} of ${shots.length} scenes are still generating.`
        );
      }
      if (!inputsHash) {
        throw new Error('Could not fingerprint the scenes for export.', {
          cause: inputsHashError,
        });
      }

      const available = await queryClient.ensureQueryData({
        queryKey: sequenceExportKeys.serverAvailable,
        queryFn: () => isServerExportAvailableFn(),
      });
      if (!available) {
        throw new Error(CONTAINER_MISSING_MESSAGE);
      }

      setProgress({ phase: 'server', completed: 0, total: 0 });
      const server = await exportSequenceOnServer({
        sequenceId: sequence.id,
        signal,
      });
      return { url: server.url, andThen };
    },
    onSuccess: ({ url, andThen }) => {
      posthog.capture('sequence_export_completed', {
        sequence_id: sequenceId,
        via: 'server',
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceExportKeys.list(sequenceId),
      });
      if (andThen === 'download') {
        toast.success('MP4 ready to download.');
        triggerDownload(url, sequence?.title);
      } else {
        const shareable = toShareableExportUrl(url);
        void copyTextToClipboard(shareable).then((copied) => {
          if (copied) {
            toast.success('Video link copied.');
            posthog.capture('video_url_copied', { sequence_id: sequenceId });
          } else {
            toast.success('MP4 ready.', {
              action: {
                label: 'Copy link',
                onClick: () => void copyTextToClipboard(shareable),
              },
            });
          }
        });
      }
    },
    onError: (error) => {
      if (abortRef.current?.signal.aborted) return;
      toast.error(toExportErrorMessage(error));
      posthog.captureException(error, { sequence_id: sequenceId });
    },
    onSettled: () => {
      setIsRunning(false);
      setProgress(null);
      abortRef.current = null;
    },
  });

  const run = useCallback(
    (andThen: SequenceExportAndThen) => {
      if (isRunning) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setIsRunning(true);
      setProgress(null);
      exportMutation.mutate({ signal: controller.signal, andThen });
    },
    [exportMutation, isRunning]
  );

  const freshExportUrl =
    (inputsHash &&
      exports?.find((e) => e.sourceShotsHash === inputsHash)?.url) ||
    null;

  const shotList = shots ?? [];
  const clipsTotal = shotList.length;
  const clipsReady = shotList.filter((s) => Boolean(s.video?.url)).length;
  const canExport = clipsTotal > 0 && clipsReady === clipsTotal;

  // The clip list is the cache key: a changed cut is a new URL, so neither the
  // query nor the browser can serve the old list. The fetch is the warm-up —
  // it makes any missing fragmented copies — and its success is what says the
  // URL is safe to hand to the player.
  const playlistKey = shots ? scenePlaybackKey(toPlaybackScenes(shots)) : '';
  const playback = useQuery({
    queryKey: ['theatre-playlist', sequenceId, playlistKey],
    queryFn: async ({ signal }) => {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(playlistKey)
      );
      const version = Array.from(new Uint8Array(digest).subarray(0, 8), (b) =>
        b.toString(16).padStart(2, '0')
      ).join('');
      const url = `/api/sequences/${sequenceId}/theatre.m3u8?v=${version}`;
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          signal,
        });
        if (response.ok) return url;
        captureVideoPlayFailed(posthog, {
          source: 'theatre',
          reason: `playlist_http_${response.status}`,
          sequence_id: sequenceId,
        });
        return null;
      } catch (error) {
        if (signal.aborted) throw error;
        captureVideoPlayFailed(posthog, {
          source: 'theatre',
          reason: 'playlist_fetch_failed',
          sequence_id: sequenceId,
        });
        return null;
      }
    },
    enabled: Boolean(sequence) && playlistKey !== '',
    staleTime: Infinity,
    retry: false,
  });
  const playbackUrl = playback.isError ? null : playback.data;

  const download = useCallback(() => {
    posthog.capture('export_clicked', {
      surface: 'theatre',
      sequence_id: sequenceId,
    });
    if (freshExportUrl) {
      triggerDownload(freshExportUrl, sequence?.title);
      posthog.capture('video_downloaded', { sequence_id: sequenceId });
      return;
    }
    if (!canExport) return;
    run('download');
  }, [freshExportUrl, canExport, run, sequence?.title, sequenceId, posthog]);

  const copyLink = useCallback(() => {
    posthog.capture('share_clicked', {
      surface: 'theatre',
      sequence_id: sequenceId,
    });
    if (freshExportUrl) {
      void copyTextToClipboard(toShareableExportUrl(freshExportUrl)).then(
        (copied) => {
          if (copied) {
            toast.success('Video link copied.');
            posthog.capture('video_url_copied', { sequence_id: sequenceId });
          } else {
            toast.error('Failed to copy URL');
          }
        }
      );
      return;
    }
    if (!canExport) return;
    run('copy-link');
  }, [freshExportUrl, canExport, run, sequenceId, posthog]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    isRunning,
    progress,
    freshExportUrl,
    playbackUrl,
    download,
    copyLink,
    abort,
    clipsReady,
    clipsTotal,
    canExport,
  };
}

function toShareableExportUrl(url: string): string {
  return new URL(url, window.location.origin).href;
}

function triggerDownload(url: string, title: string | null | undefined): void {
  const a = document.createElement('a');
  a.href = `${url}${url.includes('?') ? '&' : '?'}download`;
  a.download = `${title || 'sequence'}_openstory.mp4`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const MAX_EXPORT_ERROR_LENGTH = 500;
function toExportErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Export failed';
  return raw.length <= MAX_EXPORT_ERROR_LENGTH
    ? raw
    : `${raw.slice(0, MAX_EXPORT_ERROR_LENGTH - 1)}…`;
}
