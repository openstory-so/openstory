/**
 * Hook that drives the on-demand browser-side export pipeline:
 *   1. Reserve an upload URL via `requestSequenceExportUploadUrlFn`.
 *   2. Run the Mediabunny pipeline (`exportSequence`) — shares the
 *      `ConcatenatedVideoSource` primitive with the live `<SequencePlayer>`.
 *   3. PUT the resulting Blob to the reserved URL.
 *   4. Commit via `commitSequenceExportFn` (writes a new `sequence_exports` row).
 *
 * Every commit records `sourceShotsHash` — a SHA-256 of the scene video URLs
 * + the music choice — so `sequence_exports` is a content-addressed cache of
 * what the user is looking at (#1253). `freshExportUrl` is the cached MP4 for
 * the CURRENT state (or null), and both user actions go through the cache:
 * `download()` and `copyLink()` reuse a matching export, else export first and
 * then act. There is no "export" verb in the UI and no way to share a stale
 * cut.
 */

import {
  commitSequenceExportFn,
  listSequenceExportsFn,
  requestSequenceExportUploadUrlFn,
} from '@/functions/sequence-exports';
import { useShotsBySequence } from '@/hooks/use-shots';
import { sha256Hex } from '@/lib/compliance/hash';
import { putToR2 } from '@/lib/utils/upload';
import {
  exportSequence,
  type ExportProgress,
} from '@/lib/sequence-player/export';
import type { Sequence } from '@/types/database';
import { copyTextToClipboard } from '@/lib/utils/clipboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePostHog } from '@posthog/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

const sequenceExportKeys = {
  list: (sequenceId: string) => ['sequence-exports', sequenceId] as const,
};

// Cap the upload PUT so a stalled R2 proxy surfaces an error toast instead of
// spinning forever. Generous enough for a 5-min export on a slow connection.
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export type SequenceExportState = {
  isRunning: boolean;
  progress: ExportProgress | null;
  /** Cached export URL for the current scenes + music choice, or null. */
  freshExportUrl: string | null;
  /** False while the exports list / input hash are still loading — `freshExportUrl` is unknown, not absent. */
  isCacheResolved: boolean;
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

  const { data: exports, isLoading: exportsLoading } = useQuery({
    queryKey: sequenceExportKeys.list(sequenceId),
    queryFn: () => listSequenceExportsFn({ data: { sequenceId } }),
    staleTime: 5_000,
    enabled: Boolean(sequence),
  });

  const inputsKey = useMemo(() => {
    if (!sequence || !shots) return null;
    const sceneUrls = shots.map((f) => f.video?.url ?? null);
    if (sceneUrls.length === 0 || sceneUrls.some((u) => !u)) return null;
    return JSON.stringify({
      sceneUrls,
      musicUrl: sequence.includeMusic ? (sequence.musicUrl ?? null) : null,
    });
  }, [sequence, shots]);
  const {
    data: inputsHash,
    error: inputsHashError,
    isLoading: hashLoading,
  } = useQuery({
    queryKey: ['sequence-export-inputs-hash', inputsKey],
    queryFn: () => sha256Hex(inputsKey ?? ''),
    enabled: inputsKey !== null,
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
      andThen: 'download' | 'copy-link';
    }) => {
      if (!sequence) throw new Error('No sequence selected.');
      if (!shots || shots.length === 0) {
        throw new Error('This sequence has no shots yet.');
      }
      const scenes = shots
        .map((f) => f.video?.url)
        .filter((url): url is string => Boolean(url))
        .map((videoUrl, orderIndex) => ({ orderIndex, videoUrl }));
      if (scenes.length === 0) {
        throw new Error('No scene videos are ready yet.');
      }
      if (scenes.length !== shots.length) {
        throw new Error(
          `${shots.length - scenes.length} of ${shots.length} scenes are still generating.`
        );
      }

      // A null hash would commit an uncacheable row and silently disable the
      // fresh-export path for everyone — fail loudly instead.
      if (!inputsHash) {
        throw new Error('Could not fingerprint the scenes for export.', {
          cause: inputsHashError,
        });
      }

      const reservation = await requestSequenceExportUploadUrlFn({
        data: { sequenceId: sequence.id },
      });

      const { blob, durationSeconds, reEncoded, resolutionsLabel } =
        await exportSequence({
          scenes,
          // Omit the music track entirely when the sequence's music toggle is
          // off — the exported MP4 then carries only scene/dialogue audio (#834).
          musicUrl: sequence.includeMusic ? (sequence.musicUrl ?? null) : null,
          musicLoudnessGainDb: null,
          onProgress: setProgress,
          signal,
        });

      // Tell the user from the export's OWN probe — the player's warning is a
      // separate, possibly-unfired prepare(), so it can't be relied on (#791).
      if (reEncoded) {
        toast.info(
          resolutionsLabel
            ? `Scenes have mixed resolutions (${resolutionsLabel}); the export was normalized by re-encoding.`
            : 'Scene video encodings differ; the export was re-encoded.'
        );
      }

      // `upload` and `commit` run here, after the Mediabunny pipeline. Report
      // them through the same progress channel so a stalled upload/commit
      // doesn't masquerade as a stuck "Finalizing…" (finalize is the last
      // phase exportSequence emits). putToR2 streams via XHR and, for exports
      // over Cloudflare's ~100MB single-body limit, transparently switches to a
      // chunked R2 multipart upload.
      setProgress({ phase: 'upload', completed: 0, total: 100 });
      await putToR2(
        reservation.uploadUrl,
        blob,
        reservation.contentType,
        (percent) =>
          setProgress({ phase: 'upload', completed: percent, total: 100 }),
        { signal, timeoutMs: UPLOAD_TIMEOUT_MS }
      );

      setProgress({ phase: 'commit', completed: 0, total: 0 });
      const committed = await commitSequenceExportFn({
        data: {
          sequenceId: sequence.id,
          path: reservation.path,
          durationSeconds,
          sourceShotsHash: inputsHash,
        },
      });
      return { reEncoded, url: committed.url, andThen };
    },
    onSuccess: ({ reEncoded, url, andThen }) => {
      posthog.capture('sequence_export_completed', {
        sequence_id: sequenceId,
        re_encoded: reEncoded,
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceExportKeys.list(sequenceId),
      });
      if (andThen === 'download') {
        toast.success('MP4 ready to download.');
        triggerDownload(url, sequence?.title);
      } else {
        // The user gesture that started the export is long gone, so the
        // clipboard write may be blocked — the toast's action button gives
        // the copy a fresh gesture to run in.
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
    (andThen: 'download' | 'copy-link') => {
      if (isRunning) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setIsRunning(true);
      setProgress(null);
      exportMutation.mutate({ signal: controller.signal, andThen });
    },
    [exportMutation, isRunning]
  );

  // Match against ANY ready export, not just the newest: music-on and
  // music-off snapshots hash differently, and keeping both cached means the
  // music toggle flips between two already-rendered MP4s instead of forcing
  // a re-stitch (#1253). listBySequence is newest-first, so ties prefer the
  // most recent file.
  const freshExportUrl =
    (inputsHash &&
      exports?.find((e) => e.sourceShotsHash === inputsHash)?.url) ||
    null;

  const shotList = shots ?? [];
  const clipsTotal = shotList.length;
  const clipsReady = shotList.filter((s) => Boolean(s.video?.url)).length;
  const canExport = clipsTotal > 0 && clipsReady === clipsTotal;

  const download = useCallback(() => {
    if (freshExportUrl) {
      triggerDownload(freshExportUrl, sequence?.title);
      posthog.capture('video_downloaded', { sequence_id: sequenceId });
      return;
    }
    if (!canExport) return;
    run('download');
  }, [freshExportUrl, canExport, run, sequence?.title, sequenceId, posthog]);

  const copyLink = useCallback(() => {
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
    isCacheResolved: !exportsLoading && !hashLoading,
    download,
    copyLink,
    abort,
    clipsReady,
    clipsTotal,
    canExport,
  };
}

/**
 * Stored export URLs are origin-relative (#894) — absolutize against the
 * current origin so the copied link works when pasted elsewhere. The worker's
 * public /r2 route serves it (redirecting to the CDN in prod).
 */
function toShareableExportUrl(url: string): string {
  return new URL(url, window.location.origin).href;
}

function triggerDownload(url: string, title: string | null | undefined): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title || 'sequence'}_openstory.mp4`;
  // Browsers ignore `download` on cross-origin hrefs (the CDN domain in prod)
  // and would navigate the theatre tab away — open in a new tab instead.
  a.target = '_blank';
  a.rel = 'noopener';
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
        : 'Browser export failed';
  return raw.length <= MAX_EXPORT_ERROR_LENGTH
    ? raw
    : `${raw.slice(0, MAX_EXPORT_ERROR_LENGTH - 1)}…`;
}
