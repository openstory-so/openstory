import { characterSheetVariantKeys } from '@/hooks/use-character-sheet-variants';
import { promptVariantKeys } from '@/hooks/use-prompt-variants';
import { sceneKeys } from '@/hooks/use-scenes';
import { shotStalenessNamespace } from '@/hooks/use-shot-staleness';
import { segmentKeys } from '@/hooks/use-segments';
import { shotKeys } from '@/hooks/use-shots';
import { locationSheetVariantKeys } from '@/hooks/use-location-sheet-variants';
import { sequenceCharacterKeys } from '@/hooks/use-sequence-characters';
import { sequenceLocationKeys } from '@/hooks/use-sequence-locations';
import { musicPromptStalenessKey, sequenceKeys } from '@/hooks/use-sequences';
import { styleKeys } from '@/hooks/use-styles';
import type { Sequence } from '@/types/database';
import type { ShotView } from '@/lib/shots/shot-view';
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

// Narrows to the non-null union it actually tests, so it can guard the
// non-nullable `videoStatus` as well as the nullable `frame.imageStatus`.
function isValidShotStatus(status: unknown): status is ShotView['videoStatus'] {
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
  const shotId = getString(data, 'shotId');

  switch (eventName) {
    case 'generation.shot:created':
      // Debounced invalidation - multiple rapid events = one refetch.
      // Stream-time scene-split now also writes a `scenes` row + sceneId
      // link for each shot (#1072), so the spine list must refetch too.
      // Composed-script + the Script/Scenes tab pair also key off scenes.
      debouncedInvalidate(
        queryClient,
        shotKeys.list(sequenceId),
        `shots:${sequenceId}`
      );
      debouncedInvalidate(
        queryClient,
        sceneKeys.list(sequenceId),
        `scenes:${sequenceId}`
      );
      debouncedInvalidate(
        queryClient,
        sceneKeys.composedScript(sequenceId),
        `composed-script:${sequenceId}`
      );
      break;

    case 'generation.shot:updated': {
      // Scene metadata (title, continuity, music/audio design) lives on the
      // `scenes` row now (#1067), not on the shot — there is nothing left to
      // patch in place on the cached shot, so refresh the scene spine instead.
      debouncedInvalidate(
        queryClient,
        sceneKeys.list(sequenceId),
        `scenes:${sequenceId}`
      );
      // Prompt regenerations no longer travel in `metadata` — the visual/motion
      // prompt now lives in `frame_prompt_versions` / `shot_prompt_versions`
      // and is resolved into the `ShotView` server-side (#713). The in-place
      // `setQueryData(metadata)` above can't re-run that resolution, so refetch
      // the shots list to pick up the new prompt version + `motionPrompt`, and
      // invalidate the matching version-history query so an open prompt history
      // sheet shows the freshly appended version (#991).
      const updateType = getString(data, 'updateType');
      if (updateType === 'visual-prompt' || updateType === 'motion-prompt') {
        debouncedInvalidate(
          queryClient,
          shotKeys.list(sequenceId),
          `shots:${sequenceId}`
        );
        if (shotId) {
          const promptType =
            updateType === 'visual-prompt' ? 'visual' : 'motion';
          debouncedInvalidate(
            queryClient,
            promptVariantKeys.shot(promptType, shotId),
            `prompt-variants:${promptType}:${shotId}`
          );
        }
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
      const errorMessage = getOptionalString(data, 'error');
      // Variant-only (#547): an added (alternate) model finished — its output
      // belongs in `shot_variants`, NOT on the live primary. Skip the
      // primary shots-list write (which would flip the displayed thumbnail to
      // the alternate) and only refresh the per-model variant/model-list
      // queries below so the new model appears in the dropdown.
      const variantOnly = data.variantOnly === true;
      const promptSoftened = data.promptSoftened === true;
      const modelFallback = data.modelFallback === true;
      if (!variantOnly) {
        queryClient.setQueryData<ShotView[]>(shotKeys.list(sequenceId), (old) =>
          old?.map((f) =>
            f.id === shotId
              ? {
                  ...f,
                  // The still is a `frame_variants` row; only its url can be
                  // patched in place, and only once the row is in cache. A
                  // first render has no row yet — the invalidation below is
                  // what lands it.
                  image:
                    thumbnailUrl && f.image
                      ? { ...f.image, url: thumbnailUrl }
                      : f.image,
                  // Projected from the newest `kind: 'preview'` row (#1101).
                  // The emit carries the url so the stand-in appears without a
                  // refetch; the row itself is not in this cache.
                  previewThumbnailUrl:
                    previewThumbnailUrl ?? f.previewThumbnailUrl,
                  pendingUpscaleUrl:
                    status === 'completed' || status === 'failed'
                      ? null
                      : f.pendingUpscaleUrl,
                  pendingUpscaleIndex:
                    status === 'completed' || status === 'failed'
                      ? null
                      : f.pendingUpscaleIndex,
                  frame: {
                    ...f.frame,
                    imageStatus: isValidShotStatus(status)
                      ? status
                      : f.frame.imageStatus,
                    // Surface the failure reason live (#881): set on `failed`,
                    // clear when a new attempt starts/succeeds, and leave
                    // untouched for status-less emits (e.g. preview-url).
                    imageError:
                      status === 'failed'
                        ? (errorMessage ?? f.frame.imageError)
                        : isValidShotStatus(status)
                          ? null
                          : f.frame.imageError,
                  },
                }
              : f
          )
        );
        // A completed primary render appends a `frame_variants` row and
        // repoints `frames.selectedImageVersionId` — neither of which the
        // in-place patch above can synthesize, so refetch (#1067).
        if (status === 'completed') {
          debouncedInvalidate(
            queryClient,
            shotKeys.list(sequenceId),
            `shots:${sequenceId}`
          );
        }
      }
      // Refresh variant data so model switcher and variant overlay stay current.
      // Refresh on `failed` too (#547): image-workflow.onFailure writes a `failed`
      // variant row, and an added model's coverage marker must reflect that
      // terminal state instead of spinning `generating` until staleTime lapses —
      // matching the video/audio handlers below.
      if (status === 'completed' || status === 'failed') {
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
        // A convergent image write repoints `frames.selectedImageVersionId`,
        // which is what the editor resolves its model from (#1066).
        debouncedInvalidate(
          queryClient,
          ['sequence-selected-models', sequenceId],
          `selected-models:${sequenceId}`
        );
        // Open history sheet (#1070) — new row + Current badge.
        if (shotId) {
          debouncedInvalidate(
            queryClient,
            shotKeys.imageVersions(shotId),
            `image-versions:${shotId}`
          );
        }
      }
      // A softened prompt version just landed (#1272) — refresh visual history
      // and the shot list so Versions / the current prompt pick it up before
      // the still itself completes.
      if (promptSoftened && shotId) {
        debouncedInvalidate(
          queryClient,
          promptVariantKeys.shot('visual', shotId),
          `prompt-variants:visual:${shotId}`
        );
        debouncedInvalidate(
          queryClient,
          shotKeys.list(sequenceId),
          `shots:${sequenceId}`
        );
      }
      // Fallback still is a new `kind: 'model'` row on Grok — refresh the
      // model switcher / version history before it completes.
      if (modelFallback && shotId) {
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
        debouncedInvalidate(
          queryClient,
          shotKeys.imageVersions(shotId),
          `image-versions:${shotId}`
        );
      }
      break;
    }

    case 'generation.video:progress': {
      const videoUrl = getOptionalString(data, 'videoUrl');
      const status = data.status;
      const errorMessage = getOptionalString(data, 'error');
      const promptSoftened = data.promptSoftened === true;
      const modelFallback = data.modelFallback === true;
      // Variant-only (#547): an added (alternate) video model finished/failed —
      // its output belongs in `shot_variants`, NOT the live primary. Skip the
      // primary shots-list write (which would flip the displayed video to the
      // alternate) and only refresh the per-model variant/model-list queries
      // below so the new model appears in the dropdown.
      const variantOnly = data.variantOnly === true;
      if (!variantOnly) {
        queryClient.setQueryData<ShotView[]>(shotKeys.list(sequenceId), (old) =>
          old?.map((f) =>
            f.id === shotId
              ? {
                  ...f,
                  // The video is a `video_variants` row; same in-place limits
                  // as the still above — the completion refetch lands a first
                  // render's row.
                  video:
                    videoUrl && f.video
                      ? { ...f.video, url: videoUrl }
                      : f.video,
                  videoStatus: isValidShotStatus(status)
                    ? status
                    : f.videoStatus,
                  // Surface the failure reason live (#881) — see image handler.
                  primaryVideo: f.primaryVideo
                    ? {
                        ...f.primaryVideo,
                        error:
                          status === 'failed'
                            ? (errorMessage ?? f.primaryVideo.error)
                            : isValidShotStatus(status)
                              ? null
                              : f.primaryVideo.error,
                      }
                    : f.primaryVideo,
                }
              : f
          )
        );
        // A terminal primary render appends a `video_variants` row and repoints
        // the segment's `selectedVideoVersionId`. Neither the new row nor a
        // first failure's `error` can be synthesized in place, so refetch
        // (#1067).
        if (status === 'completed' || status === 'failed') {
          debouncedInvalidate(
            queryClient,
            shotKeys.list(sequenceId),
            `shots:${sequenceId}`
          );
        }
      }
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
        // A convergent video write repoints the render segment's
        // `selectedVideoVersionId` — the editor's model source (#1066).
        debouncedInvalidate(
          queryClient,
          ['sequence-selected-models', sequenceId],
          `selected-models:${sequenceId}`
        );
        // Open history sheet (#1070) — new row + Current badge.
        if (shotId) {
          debouncedInvalidate(
            queryClient,
            shotKeys.videoVersions(shotId),
            `video-versions:${shotId}`
          );
        }
        // Version chips on the Video tab read `segments`, not history and not
        // the shots list. History was invalidated above (#1070) but segments
        // were not — after primary completion we also flip `shots.videoStatus`
        // off `generating`, which stops the 2s segment poll, so a chip can
        // stay on the pre-complete "generating" snapshot forever while history
        // already shows completed (#1076).
        debouncedInvalidate(
          queryClient,
          segmentKeys.list(sequenceId),
          `segments:${sequenceId}`
        );
      }
      // Content-checker rescue (#1373), mirroring the image handler: a
      // softened motion prompt version repoints the shot's selection (primary
      // render) or lands in its history (variant-only), and a fallback render
      // moves the in-flight version to the Grok group.
      if (promptSoftened && shotId) {
        debouncedInvalidate(
          queryClient,
          promptVariantKeys.shot('motion', shotId),
          `prompt-variants:motion:${shotId}`
        );
        debouncedInvalidate(
          queryClient,
          shotKeys.list(sequenceId),
          `shots:${sequenceId}`
        );
      }
      if (modelFallback && shotId) {
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
        debouncedInvalidate(
          queryClient,
          shotKeys.videoVersions(shotId),
          `video-versions:${shotId}`
        );
      }
      break;
    }

    case 'generation.variant-image:progress': {
      const variantImageUrl = getOptionalString(data, 'variantImageUrl');
      const status = data.status;
      queryClient.setQueryData<ShotView[]>(shotKeys.list(sequenceId), (old) =>
        old?.map((f) =>
          f.id === shotId
            ? {
                ...f,
                gridSheet: {
                  url: variantImageUrl ?? f.gridSheet?.url ?? null,
                  status: isValidShotStatus(status)
                    ? status
                    : (f.gridSheet?.status ?? null),
                },
              }
            : f
        )
      );
      break;
    }

    case 'generation.audio:progress': {
      const status = data.status;
      const audioUrl = getOptionalString(data, 'audioUrl');
      const model = getOptionalString(data, 'model');
      if (isValidMusicStatus(status)) {
        queryClient.setQueryData<Sequence>(
          sequenceKeys.detail(sequenceId),
          (old) => {
            if (!old) return old;
            // Only the primary model owns the live `sequences.music*` columns.
            // In a multi-model fan-out (#546) secondary models emit model-scoped
            // events purely to refresh the per-model queries below — applying
            // their status/url here would clobber the primary (last-writer-wins,
            // and a secondary failure would mask a working primary track). The
            // primary's `set-generating-status` writes `musicModel` first, so
            // match against it; a missing `model` (single-model / legacy
            // emitters) is treated as the primary.
            if (model && old.musicModel && model !== old.musicModel) {
              return old;
            }
            return {
              ...old,
              musicStatus: status,
              ...(audioUrl ? { musicUrl: audioUrl } : {}),
            };
          }
        );
      }
      // Refresh per-model audio data so the header model dropdown and the
      // music-tab track switcher stay current (#546). Audio is sequence-level
      // (sequence_music_variants), so these are separate queries from the shot
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

    case 'generation.style:ready': {
      const styleId = getString(data, 'styleId');
      if (styleId) {
        debouncedInvalidate(
          queryClient,
          styleKeys.detail(styleId),
          `style:${styleId}`
        );
      }
      debouncedInvalidate(
        queryClient,
        styleKeys.forSequence(sequenceId),
        `style:sequence:${sequenceId}`
      );
      // `sequence.styleConfig` flipping non-null is what ends the pending state.
      debouncedInvalidate(
        queryClient,
        sequenceKeys.detail(sequenceId),
        `sequence:${sequenceId}`
      );
      break;
    }

    case 'generation.stale:detected': {
      // A divergent regeneration parked its result in a `*_variants` table.
      // This handler runs on the sequence channel, so it only fires for
      // entityTypes routed there: `shot`, `character`, `location`. Per-entity
      // channels handle their own invalidation (`useTalentSheetRealtime`,
      // `useLocationSheetRealtime`) for `talent` and `library-location`.
      const entityType = getString(data, 'entityType');
      const entityId = getString(data, 'entityId');
      if (!entityId) break;
      switch (entityType) {
        case 'shot':
          // Shot thumbnail/video divergence: refresh variants list, the shot
          // itself (status reverts to pending), and per-shot staleness so the
          // indicator reappears even if the user just dismissed it.
          debouncedInvalidate(
            queryClient,
            ['sequence-image-variants', sequenceId],
            `image-variants:${sequenceId}`
          );
          debouncedInvalidate(
            queryClient,
            shotKeys.list(sequenceId),
            `shots:${sequenceId}`
          );
          // Namespace-wide: also refreshes the scene-scoped entry that feeds
          // the scene summary and left-rail dots (#1077). Debounced per
          // sequence, not per shot — the payload is sequence-wide, so a
          // per-shot key would fan a burst of shot events into N identical
          // namespace invalidations, each refetching every shot's hashes.
          debouncedInvalidate(
            queryClient,
            [...shotStalenessNamespace],
            `shot-staleness:${sequenceId}`
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

    case 'generation.character-sheet:progress':
    case 'generation.talent:matched':
      // Cast was created / cast / had its sheet generated during a run.
      // Refresh the character list so the cast grid (TalentView) and the
      // per-scene cast (SceneCastTab) populate live instead of only after a
      // page refresh. Debounced because character-sheet:progress fires
      // generating + completed for every character.
      debouncedInvalidate(
        queryClient,
        sequenceCharacterKeys.list(sequenceId),
        `sequence-characters:${sequenceId}`
      );
      break;

    case 'generation.preview:replaced':
      // Preview shots replaced by AI-analyzed shots — refetch shot list
      void queryClient.invalidateQueries({
        queryKey: shotKeys.list(sequenceId),
      });
      break;

    case 'generation.complete':
    case 'generation.failed':
    case 'generation.reservation:short':
    case 'generation.updated':
      // Invalidate sequence to get updated status/title
      void queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });
      // Final catch-all so the cast list reflects the finished run even if an
      // intermediate character event was missed.
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.list(sequenceId),
      });
      // Staleness was deferred for the whole run (#1121: every artifact reads
      // 'generating' while the sequence is 'processing'). The run ending is
      // the moment a real verdict becomes computable, and nothing else
      // invalidates this namespace at that point — without it the deferred
      // entries sit in cache until something unrelated refetches them.
      void queryClient.invalidateQueries({
        queryKey: shotStalenessNamespace,
      });
      void queryClient.invalidateQueries({
        queryKey: musicPromptStalenessKey(sequenceId),
      });
      break;

    case 'generation.error':
      // Update shot status if shotId present
      if (shotId) {
        queryClient.setQueryData<ShotView[]>(shotKeys.list(sequenceId), (old) =>
          old?.map((f) =>
            f.id === shotId
              ? {
                  ...f,
                  frame: { ...f.frame, imageStatus: 'failed' },
                  videoStatus: 'failed',
                }
              : f
          )
        );
      }
      break;

    case 'generation.scene:updated': {
      // Scene titles render off the scenes query now, so refetching it is the
      // whole update (#1072).
      debouncedInvalidate(
        queryClient,
        sceneKeys.list(sequenceId),
        `scenes:${sequenceId}`
      );
      debouncedInvalidate(
        queryClient,
        shotKeys.list(sequenceId),
        `shots:${sequenceId}`
      );
      break;
    }

    case 'generation.scene:new':
      // Analysis now persists a scenes row as each scene completes (#1072).
      // Refetch so the spine grows scene groups live instead of only after
      // the late bulk persist-scenes step — and so the Script tab collapses
      // once the first scene lands.
      debouncedInvalidate(
        queryClient,
        sceneKeys.list(sequenceId),
        `scenes:${sequenceId}`
      );
      debouncedInvalidate(
        queryClient,
        shotKeys.list(sequenceId),
        `shots:${sequenceId}`
      );
      debouncedInvalidate(
        queryClient,
        sceneKeys.composedScript(sequenceId),
        `composed-script:${sequenceId}`
      );
      break;

    // Phase events don't need cache updates (UI-only via reducer state)
  }
}
