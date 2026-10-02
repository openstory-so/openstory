/**
 * On-demand sequence export. Download/Copy use a ready row whose
 * `sourceShotsHash` matches the current cut; `render` POSTs
 * `/api/v1/sequences/$id/exports` and polls until that row exists. There is
 * no in-browser encode, and theatre playback never waits on an export.
 */

import {
  isServerExportAvailableFn,
  listSequenceExportsFn,
} from '@/sequences/sequence-exports.fn';
import { useShotsBySequence } from '@/shots/ui/use-shots';
import { collapseConsecutiveUrls } from './playback-clips';
import {
  effectiveExportMusicUrl,
  hashSequenceExportInputs,
  sequenceExportInputsKey,
} from './source-shots-hash';
import { exportSequenceOnServer } from './server-export-client';
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

export type SequenceExportState = {
  /** A server render of the current cut is in flight (this tab is waiting on it). */
  isRunning: boolean;
  /** `Date.now()` when the render in flight started, for the elapsed clock. */
  renderStartedAt: number | null;
  /** Ready MP4 of the current scenes + music choice, or null. */
  freshExportUrl: string | null;
  /** The `sequence_exports` row behind `freshExportUrl` (publishing, #1267). */
  freshExportId: string | null;
  /** A ready MP4 exists, but of an earlier cut. */
  hasStaleExport: boolean;
  /** Download the current cut's MP4. No-op until it has been rendered. */
  download: () => void;
  /** Copy a shareable URL for the current cut's MP4. No-op until rendered. */
  copyLink: () => void;
  /** Render the current cut to MP4 on the server. */
  render: () => void;
  /** Stop waiting. The server keeps rendering; `render` rejoins it. */
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
  const [renderStartedAt, setRenderStartedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const exportMutation = useMutation({
    mutationFn: async ({ signal }: { signal: AbortSignal }) => {
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

      return exportSequenceOnServer({ sequenceId: sequence.id, signal });
    },
    onSuccess: ({ url }) => {
      posthog.capture('sequence_export_completed', {
        sequence_id: sequenceId,
        via: 'server',
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceExportKeys.list(sequenceId),
      });
      toast.success('MP4 ready.', {
        action: {
          label: 'Download',
          onClick: () => triggerDownload(url, sequence?.title),
        },
      });
    },
    onError: (error) => {
      if (abortRef.current?.signal.aborted) return;
      toast.error(toExportErrorMessage(error));
      posthog.captureException(error, { sequence_id: sequenceId });
    },
    onSettled: () => {
      setIsRunning(false);
      setRenderStartedAt(null);
      abortRef.current = null;
    },
  });

  const render = useCallback(() => {
    if (isRunning) return;
    posthog.capture('export_clicked', {
      surface: 'theatre',
      sequence_id: sequenceId,
    });
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setRenderStartedAt(Date.now());
    exportMutation.mutate({ signal: controller.signal });
  }, [exportMutation, isRunning, posthog, sequenceId]);

  const freshExport =
    (inputsHash && exports?.find((e) => e.sourceShotsHash === inputsHash)) ||
    null;
  const freshExportUrl = freshExport?.url ?? null;
  // The list is ready rows only.
  const hasStaleExport = !freshExportUrl && Boolean(exports?.length);

  const shotList = shots ?? [];
  const clipsTotal = shotList.length;
  const clipsReady = shotList.filter((s) => Boolean(s.video?.url)).length;
  const canExport = clipsTotal > 0 && clipsReady === clipsTotal;

  const download = useCallback(() => {
    if (!freshExportUrl) return;
    triggerDownload(freshExportUrl, sequence?.title);
    posthog.capture('video_downloaded', { sequence_id: sequenceId });
  }, [freshExportUrl, sequence?.title, sequenceId, posthog]);

  const copyLink = useCallback(() => {
    posthog.capture('share_clicked', {
      surface: 'theatre',
      sequence_id: sequenceId,
    });
    if (!freshExportUrl) return;
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
  }, [freshExportUrl, sequenceId, posthog]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    isRunning,
    renderStartedAt,
    freshExportUrl,
    freshExportId: freshExport?.id ?? null,
    hasStaleExport,
    download,
    copyLink,
    render,
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
