/**
 * Manual media inject mutations (#1108 Phase 3) — presign → R2 PUT → finalize,
 * the same transport `useUploadElementToSequence` uses. Each finalize appends
 * an uploaded version server-side and selects it; the invalidation sets mirror
 * the corresponding select-version hooks in `use-shots.ts` so the new still /
 * clip and derived staleness dots appear everywhere at once.
 */

import {
  presignCharacterSheetUploadFn,
  presignFrameImageUploadFn,
  presignLocationSheetUploadFn,
  presignSequenceMusicUploadFn,
  presignShotVideoUploadFn,
  replaceFrameContentFn,
  setCharacterSheetFromUploadFn,
  setLocationSheetFromUploadFn,
  setSequenceMusicFromUploadFn,
  setShotVideoFromUploadFn,
} from '@/functions/media-upload';
import { characterSheetVariantKeys } from '@/hooks/use-character-sheet-variants';
import { locationSheetVariantKeys } from '@/hooks/use-location-sheet-variants';
import { promptVariantKeys } from '@/hooks/use-prompt-variants';
import { segmentKeys } from '@/hooks/use-segments';
import { sequenceCharacterKeys } from '@/hooks/use-sequence-characters';
import { sequenceLocationKeys } from '@/hooks/use-sequence-locations';
import { sequenceKeys } from '@/hooks/use-sequences';
import { shotStalenessNamespace } from '@/hooks/use-shot-staleness';
import { shotKeys } from '@/hooks/use-shots';
import { putToR2 } from '@/lib/utils/upload';
import { fitImageFileToAspectRatio } from '@/lib/utils/fit-image-aspect';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { useMutation, useQueryClient } from '@tanstack/react-query';

async function presignPut(
  presign: Promise<{
    uploadUrl: string;
    contentType: string;
    publicUrl: string;
  }>,
  file: File,
  onProgress?: (percent: number) => void
): Promise<string> {
  const signed = await presign;
  await putToR2(signed.uploadUrl, file, signed.contentType, onProgress);
  return signed.publicUrl;
}

/**
 * Replace a shot's still with an uploaded image. With `promptText` (an unsaved
 * prompt edit riding along), the atomic prompt+image server fn commits both in
 * one batch (§4.3 C) so the image is never observed stale against its prompt;
 * without it, the image-only path leaves the visual prompt untouched (§4.3 B).
 */
export function useReplaceFrameImage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      sequenceId: string;
      shotId: string;
      aspectRatio: AspectRatio;
      promptText?: string;
      onProgress?: (percent: number) => void;
    }): Promise<{ promptChanged: boolean; cropped: boolean }> => {
      const fitted = await fitImageFileToAspectRatio(
        input.file,
        input.aspectRatio
      );
      const publicUrl = await presignPut(
        presignFrameImageUploadFn({
          data: {
            sequenceId: input.sequenceId,
            shotId: input.shotId,
            filename: fitted.file.name,
          },
        }),
        fitted.file,
        input.onProgress
      );
      const result = await replaceFrameContentFn({
        data: {
          sequenceId: input.sequenceId,
          shotId: input.shotId,
          publicUrl,
          ...(input.promptText !== undefined
            ? { promptText: input.promptText }
            : {}),
        },
      });
      return { promptChanged: result.promptChanged, cropped: fitted.cropped };
    },
    onSuccess: async (_result, { sequenceId, shotId }) => {
      // Same set useSelectFrameImageVersion refreshes: the selection repointed,
      // history grew, video derives stale, and the prompt may have changed.
      // NOT `sequence-image-variants`: that list is `kind:'model'` only and
      // every consumer matches on a valid model id, so an upload can never
      // appear in it — the per-shot history sheet (`imageVersions`) is where
      // uploads live and where switching back happens.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
        queryClient.invalidateQueries({ queryKey: shotKeys.detail(shotId) }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.imageVersions(shotId),
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-selected-models', sequenceId],
        }),
        queryClient.invalidateQueries({
          queryKey: segmentKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: promptVariantKeys.shot('visual', shotId),
        }),
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]);
    },
  });
}

/** Replace a shot's video with an uploaded clip (appended + selected). */
export function useReplaceShotVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      sequenceId: string;
      shotId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const publicUrl = await presignPut(
        presignShotVideoUploadFn({
          data: {
            sequenceId: input.sequenceId,
            shotId: input.shotId,
            filename: input.file.name,
          },
        }),
        input.file,
        input.onProgress
      );
      // The clip's own length is what the shot now runs for — the server
      // re-snaps `shots.durationMs` from this before it hashes the render
      // manifest, so the timeline and the bytes agree.
      const durationSeconds = await readMediaDuration(input.file, 'video');
      return setShotVideoFromUploadFn({
        data: {
          sequenceId: input.sequenceId,
          shotId: input.shotId,
          publicUrl,
          durationSeconds,
        },
      });
    },
    onSuccess: async (_result, { sequenceId, shotId }) => {
      // Mirror useSetVideoFromVariant, plus the version history this appended to.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: shotKeys.list(sequenceId) }),
        queryClient.invalidateQueries({ queryKey: shotKeys.detail(shotId) }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.videoVersions(shotId),
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-video-variants', sequenceId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-selected-models', sequenceId],
        }),
        queryClient.invalidateQueries({
          queryKey: segmentKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]);
    },
  });
}

/**
 * Decode a media file's duration from its metadata; `undefined` when the
 * browser can't (both server fns treat it as optional and fall back to the
 * stored value).
 */
function readMediaDuration(
  file: File,
  kind: 'audio' | 'video'
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const element =
      kind === 'audio' ? new Audio() : document.createElement('video');
    const finish = (duration?: number) => {
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    element.onloadedmetadata = () =>
      finish(
        Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : undefined
      );
    element.onerror = () => finish(undefined);
    element.preload = 'metadata';
    element.src = objectUrl;
  });
}

/**
 * Manual character-sheet upload — the sequence-side mirror of the library
 * `manual_upload` source. Finalize stamps the current-inputs hash on parent
 * and version; stills re-stale because the selected version id is new.
 */
export function useUploadCharacterSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      sequenceId: string;
      characterId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const publicUrl = await presignPut(
        presignCharacterSheetUploadFn({
          data: {
            sequenceId: input.sequenceId,
            characterId: input.characterId,
            filename: input.file.name,
          },
        }),
        input.file,
        input.onProgress
      );
      return setCharacterSheetFromUploadFn({
        data: {
          sequenceId: input.sequenceId,
          characterId: input.characterId,
          publicUrl,
        },
      });
    },
    onSuccess: async (_result, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceCharacterKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: characterSheetVariantKeys.all,
        }),
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]);
    },
  });
}

/** Location twin of `useUploadCharacterSheet` (reference image). */
export function useUploadLocationReference() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      sequenceId: string;
      locationDbId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const publicUrl = await presignPut(
        presignLocationSheetUploadFn({
          data: {
            sequenceId: input.sequenceId,
            locationDbId: input.locationDbId,
            filename: input.file.name,
          },
        }),
        input.file,
        input.onProgress
      );
      return setLocationSheetFromUploadFn({
        data: {
          sequenceId: input.sequenceId,
          locationDbId: input.locationDbId,
          publicUrl,
        },
      });
    },
    onSuccess: async (_result, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceLocationKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: locationSheetVariantKeys.all,
        }),
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]);
    },
  });
}

/** Upload an audio file as the sequence's score (user-upload primary slot). */
export function useUploadSequenceMusic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      sequenceId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const publicUrl = await presignPut(
        presignSequenceMusicUploadFn({
          data: { sequenceId: input.sequenceId, filename: input.file.name },
        }),
        input.file,
        input.onProgress
      );
      const durationSeconds = await readMediaDuration(input.file, 'audio');
      return setSequenceMusicFromUploadFn({
        data: {
          sequenceId: input.sequenceId,
          publicUrl,
          durationSeconds,
        },
      });
    },
    onSuccess: async (_result, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-audio-variants', sequenceId],
        }),
      ]);
    },
  });
}
