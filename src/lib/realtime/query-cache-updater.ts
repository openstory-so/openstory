import { characterSheetVariantKeys } from '@/hooks/use-character-sheet-variants';
import { frameKeys } from '@/hooks/use-frames';
import { locationSheetVariantKeys } from '@/hooks/use-location-sheet-variants';
import { sequenceCharacterKeys } from '@/hooks/use-sequence-characters';
import { sequenceLocationKeys } from '@/hooks/use-sequence-locations';
import { sequenceKeys } from '@/hooks/use-sequences';
import type { Frame, Sequence } from '@/types/database';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Helper to safely extract typed values from event data.
 * Uses runtime checks instead of unsafe type assertions.
 */
function getString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

function getOptionalString(
  data: Record<string, unknown>,
  key: string
): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Type guard for Scene metadata from realtime events.
 * Performs minimal runtime validation since data is already Zod-validated upstream.
 */
function isSceneMetadata(value: unknown): value is Frame['metadata'] {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object') return false;
  // Check for required Scene fields using 'in' operator for type narrowing
  return (
    typeof value === 'object' &&
    'sceneId' in value &&
    typeof value.sceneId === 'string' &&
    'sceneNumber' in value &&
    typeof value.sceneNumber === 'number'
  );
}

// Debounce invalidations per query key - multiple rapid events = one refetch
const pendingInvalidations = new Map<string, NodeJS.Timeout>();
const DEBOUNCE_MS = 100;

function debouncedInvalidate(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  debounceKey: string
) {
  // Clear any pending invalidation for this key
  const existing = pendingInvalidations.get(debounceKey);
  if (existing) clearTimeout(existing);

  // Schedule new invalidation
  const timeout = setTimeout(() => {
    pendingInvalidations.delete(debounceKey);
    void queryClient.invalidateQueries({ queryKey });
  }, DEBOUNCE_MS);

  pendingInvalidations.set(debounceKey, timeout);
}

/**
 * Validates if a status value is a valid music status.
 */
function isValidMusicStatus(
  status: unknown
): status is Sequence['musicStatus'] {
  return (
    status === 'pending' ||
    status === 'generating' ||
    status === 'completed' ||
    status === 'failed'
  );
}

function isValidFrameStatus(
  status: unknown
): status is Frame['thumbnailStatus'] {
  return (
    status === 'pending' ||
    status === 'generating' ||
    status === 'completed' ||
    status === 'failed'
  );
}

/**
 * Updates TanStack Query cache based on realtime generation events.
 * This enables instant UI updates without polling.
 */
export function updateQueryCacheFromEvent(
  queryClient: QueryClient,
  sequenceId: string,
  eventName: string,
  data: Record<string, unknown>
) {
  const frameId = getString(data, 'frameId');

  switch (eventName) {
    case 'generation.frame:created':
      // Debounced invalidation - multiple rapid events = one refetch
      debouncedInvalidate(
        queryClient,
        frameKeys.list(sequenceId),
        `frames:${sequenceId}`
      );
      break;

    case 'generation.frame:updated': {
      // Update frame metadata with prompts
      // The metadata is validated by the realtime schema before reaching here
      const metadata = data.metadata;
      if (isSceneMetadata(metadata)) {
        queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
          old?.map((f) => (f.id === frameId ? { ...f, metadata } : f))
        );
      }
      break;
    }

    case 'generation.image:progress': {
      const thumbnailUrl = getOptionalString(data, 'thumbnailUrl');
      const previewThumbnailUrl = getOptionalString(
        data,
        'previewThumbnailUrl'
      );
      const status = data.status;
      queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
        old?.map((f) =>
          f.id === frameId
            ? {
                ...f,
                thumbnailUrl: thumbnailUrl ?? f.thumbnailUrl,
                previewThumbnailUrl:
                  previewThumbnailUrl ?? f.previewThumbnailUrl,
                thumbnailStatus: isValidFrameStatus(status)
                  ? status
                  : f.thumbnailStatus,
              }
            : f
        )
      );
      // Refresh variant data so model switcher and variant overlay stay current
      if (status === 'completed') {
        debouncedInvalidate(
          queryClient,
          ['sequence-image-variants', sequenceId],
          `image-variants:${sequenceId}`
        );
        debouncedInvalidate(
          queryClient,
          ['sequence-image-models', sequenceId],
          `image-models:${sequenceId}`
        );
      }
      break;
    }

    case 'generation.video:progress': {
      const videoUrl = getOptionalString(data, 'videoUrl');
      const status = data.status;
      queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
        old?.map((f) =>
          f.id === frameId
            ? {
                ...f,
                videoUrl: videoUrl ?? f.videoUrl,
                videoStatus: isValidFrameStatus(status)
                  ? status
                  : f.videoStatus,
              }
            : f
        )
      );
      // Refresh video variant data so the model switcher and per-model overlay
      // stay current (#545). Unlike the image handler, refresh on `failed` too:
      // motion-workflow.onFailure writes a `failed` variant row, and the
      // switcher should reflect that terminal state without waiting for a
      // background refetch.
      if (status === 'completed' || status === 'failed') {
        debouncedInvalidate(
          queryClient,
          ['sequence-video-variants', sequenceId],
          `video-variants:${sequenceId}`
        );
        debouncedInvalidate(
          queryClient,
          ['sequence-video-models', sequenceId],
          `video-models:${sequenceId}`
        );
      }
      break;
    }

    case 'generation.variant-image:progress': {
      const variantImageUrl = getOptionalString(data, 'variantImageUrl');
      const status = data.status;
      queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
        old?.map((f) =>
          f.id === frameId
            ? {
                ...f,
                variantImageUrl: variantImageUrl ?? f.variantImageUrl,
                variantImageStatus: isValidFrameStatus(status)
                  ? status
                  : f.variantImageStatus,
              }
            : f
        )
      );
      break;
    }

    case 'generation.audio:progress': {
      const status = data.status;
      const audioUrl = getOptionalString(data, 'audioUrl');
      if (isValidMusicStatus(status)) {
        queryClient.setQueryData<Sequence>(
          sequenceKeys.detail(sequenceId),
          (old) =>
            old
              ? {
                  ...old,
                  musicStatus: status,
                  ...(audioUrl ? { musicUrl: audioUrl } : {}),
                }
              : old
        );
      }
      // Refresh per-model audio data so the header model dropdown and the
      // music-tab track switcher stay current (#546). Audio is sequence-level
      // (sequence_music_variants), so these are separate queries from the frame
      // image/video variant ones.
      if (status === 'completed' || status === 'failed') {
        debouncedInvalidate(
          queryClient,
          ['sequence-audio-variants', sequenceId],
          `audio-variants:${sequenceId}`
        );
        debouncedInvalidate(
          queryClient,
          ['sequence-audio-models', sequenceId],
          `audio-models:${sequenceId}`
        );
      }
      break;
    }

    case 'generation.poster:ready': {
      const posterUrl = getOptionalString(data, 'posterUrl');
      if (posterUrl) {
        queryClient.setQueryData<Sequence>(
          sequenceKeys.detail(sequenceId),
          (old) => (old ? { ...old, posterUrl } : old)
        );
      }
      break;
    }

    case 'generation.stale:detected': {
      // A divergent regeneration parked its result in a `*_variants` table.
      // This handler runs on the sequence channel, so it only fires for
      // entityTypes routed there: `frame`, `character`, `location`. Per-entity
      // channels handle their own invalidation (`useTalentSheetRealtime`,
      // `useLocationSheetRealtime`) for `talent` and `library-location`.
      const entityType = getString(data, 'entityType');
      const entityId = getString(data, 'entityId');
      if (!entityId) break;
      switch (entityType) {
        case 'frame':
          // Frame thumbnail/video divergence: refresh variants list, the frame
          // itself (status reverts to pending), and per-frame staleness so the
          // indicator reappears even if the user just dismissed it.
          debouncedInvalidate(
            queryClient,
            ['sequence-image-variants', sequenceId],
            `image-variants:${sequenceId}`
          );
          debouncedInvalidate(
            queryClient,
            frameKeys.list(sequenceId),
            `frames:${sequenceId}`
          );
          debouncedInvalidate(
            queryClient,
            ['frame-staleness', entityId],
            `frame-staleness:${entityId}`
          );
          break;

        case 'character':
          // Character sheet diverged into `character_sheet_variants`. The
          // primary row's `sheetStatus` was settled to `completed` by the
          // workflow; refetch so the spinner clears and any variant-surfacing
          // UI picks up the new alternate.
          debouncedInvalidate(
            queryClient,
            sequenceCharacterKeys.list(sequenceId),
            `sequence-characters:${sequenceId}`
          );
          debouncedInvalidate(
            queryClient,
            characterSheetVariantKeys.divergentBySequence(sequenceId),
            `character-sheet-divergent:${sequenceId}`
          );
          break;

        case 'location':
          // Sequence-location reference diverged into
          // `location_sheet_variants` (parentType `sequence_location`).
          debouncedInvalidate(
            queryClient,
            sequenceLocationKeys.list(sequenceId),
            `sequence-locations:${sequenceId}`
          );
          debouncedInvalidate(
            queryClient,
            locationSheetVariantKeys.divergentBySequence(sequenceId),
            `location-sheet-divergent:${sequenceId}`
          );
          break;

        case 'sequence': {
          // Sequence-level music diverged into `sequence_music_variants`.
          // Refresh the divergent-list query so the inline banner appears,
          // plus the sequence detail (its `musicStatus` may have just settled
          // back to 'completed').
          const artifact = getString(data, 'artifact');
          if (artifact === 'music') {
            debouncedInvalidate(
              queryClient,
              ['sequence-divergent-music', sequenceId],
              `sequence-divergent-music:${sequenceId}`
            );
          }
          debouncedInvalidate(
            queryClient,
            sequenceKeys.detail(sequenceId),
            `sequence:${sequenceId}`
          );
          // Team-aggregate dashboard query: corner-dot on /sequences depends
          // on it, and the dashboard route doesn't subscribe to per-sequence
          // channels — invalidate here so a divergence appearing while the
          // user sits on the dashboard surfaces without staleTime/focus delay.
          debouncedInvalidate(
            queryClient,
            ['sequence-divergent-by-team'],
            'sequence-divergent-by-team'
          );
          break;
        }
      }
      break;
    }

    case 'generation.preview:replaced':
      // Preview frames replaced by AI-analyzed frames — refetch frame list
      void queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
      break;

    case 'generation.complete':
    case 'generation.failed':
    case 'generation.updated':
      // Invalidate sequence to get updated status/title
      void queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });
      break;

    case 'generation.error':
      // Update frame status if frameId present
      if (frameId) {
        queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
          old?.map((f) =>
            f.id === frameId
              ? { ...f, thumbnailStatus: 'failed', videoStatus: 'failed' }
              : f
          )
        );
      }
      break;

    case 'generation.scene:updated': {
      // Update frame metadata title in cache by matching sceneId
      const sceneId = getString(data, 'sceneId');
      const title = getString(data, 'title');
      if (sceneId && title) {
        queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
          old?.map((f) => {
            if (f.metadata?.sceneId !== sceneId || !f.metadata.metadata)
              return f;
            return {
              ...f,
              metadata: {
                ...f.metadata,
                metadata: {
                  ...f.metadata.metadata,
                  title,
                },
              },
            };
          })
        );
      }
      break;
    }

    // Phase events don't need cache updates (UI-only via reducer state)
    // scene:new events don't need cache updates (analysis phase, no frames yet)
  }
}
