import {
  cancelPendingArtifactFn,
  listSequenceMusicPromptVariantsFn,
  listShotPromptVariantsFn,
  restoreSequenceMusicPromptVariantFn,
  restoreShotPromptVariantFn,
  saveShotPromptFn,
  type SequenceMusicPromptVariantWithAuthor,
  type ShotPromptVariantWithAuthor,
} from '@/shots/prompt-variants.fn';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { shotStalenessNamespace } from './use-shot-staleness';
import { shotKeys } from './use-shots';

/**
 * The two shot-prompt history axes. Visual history lives in
 * `frame_prompt_versions`, motion in `shot_prompt_versions` (#989/#713), but
 * both resolve through the shot id on the client (the server fn narrows to the
 * anchor frame for visual). Keyed by shot id so the realtime
 * `generation.shot:updated` handler — which only knows the shot id — can
 * invalidate the matching history query when a run appends a new version.
 */
export type ShotPromptType = 'visual' | 'motion';

/**
 * Query-key factory for prompt version history (per variant group). Shared by
 * the consumer hooks below AND the realtime cache updater so a regeneration /
 * selection event invalidates the exact key the open history sheet reads —
 * keyed to the frame/shot + prompt axis, not the shot's still (#991).
 */
export const promptVariantKeys = {
  all: ['prompt-variants'] as const,
  shot: (promptType: ShotPromptType, shotId: string) =>
    [...promptVariantKeys.all, promptType, shotId] as const,
  music: (sequenceId: string) =>
    [...promptVariantKeys.all, 'music', sequenceId] as const,
};

/**
 * Version history for a shot's visual or motion prompt, newest first. The
 * current selection is the `selected*PromptVersionId` pointer already projected
 * onto the shot/anchor-frame in `ShotView` (no extra fetch needed).
 */
export function useShotPromptVariants(
  args: { sequenceId: string; shotId: string; promptType: ShotPromptType },
  options?: { enabled?: boolean }
) {
  return useQuery<ShotPromptVariantWithAuthor[]>({
    queryKey: promptVariantKeys.shot(args.promptType, args.shotId),
    queryFn: () => listShotPromptVariantsFn({ data: args }),
    enabled: options?.enabled ?? true,
    staleTime: 5_000,
  });
}

/** Version history for a sequence's music prompt, newest first. */
export function useSequenceMusicPromptVariants(
  sequenceId: string,
  options?: { enabled?: boolean }
) {
  return useQuery<SequenceMusicPromptVariantWithAuthor[]>({
    queryKey: promptVariantKeys.music(sequenceId),
    queryFn: () => listSequenceMusicPromptVariantsFn({ data: { sequenceId } }),
    enabled: options?.enabled ?? true,
    staleTime: 5_000,
  });
}

/**
 * Restore an older shot-prompt version (appends a new `restored` entry and
 * repoints the selection). Invalidates the history list plus the shot's
 * read projection so the live prompt + staleness pick up the restore.
 */
export function useRestoreShotPromptVariant(args: {
  sequenceId: string;
  shotId: string;
  promptType: ShotPromptType;
}) {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, string>({
    mutationFn: (variantId) =>
      restoreShotPromptVariantFn({
        data: {
          sequenceId: args.sequenceId,
          shotId: args.shotId,
          variantId,
          promptType: args.promptType,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: promptVariantKeys.shot(args.promptType, args.shotId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.detail(args.shotId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.list(args.sequenceId),
        }),
      ]);
    },
  });
}

/**
 * Persist a hand-edited / shortened prompt as a `user-edit` version WITHOUT
 * rendering. Invalidates the history list, the shot read projection (so the
 * live prompt + `motionPrompt` pick up the edit), and staleness (a fresh
 * user-edit aligns the prompt with the current upstream hash).
 */
export function useSaveShotPrompt(args: {
  sequenceId: string;
  shotId: string;
  promptType: ShotPromptType;
}) {
  const queryClient = useQueryClient();
  return useMutation<
    { unchanged: true } | { unchanged: false; versionId: string },
    Error,
    string
  >({
    mutationFn: (text) =>
      saveShotPromptFn({
        data: {
          sequenceId: args.sequenceId,
          shotId: args.shotId,
          promptType: args.promptType,
          text,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: promptVariantKeys.shot(args.promptType, args.shotId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.detail(args.shotId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.list(args.sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotStalenessNamespace,
        }),
      ]);
    },
  });
}

/**
 * Cancel an in-flight pending artifact claim (#1085). Invalidates the history
 * lists, the shot projection, and the staleness namespace — a cancelled claim
 * flips the artifact from 'updating' back to 'stale'.
 */
export function useCancelPendingArtifact(args: {
  sequenceId: string;
  shotId: string;
}) {
  const queryClient = useQueryClient();
  return useMutation<
    { cancelled: boolean },
    Error,
    { versionId: string; artifact: 'visual-prompt' | 'motion-prompt' | 'image' }
  >({
    mutationFn: ({ versionId, artifact }) =>
      cancelPendingArtifactFn({
        data: {
          sequenceId: args.sequenceId,
          shotId: args.shotId,
          versionId,
          artifact,
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: promptVariantKeys.all }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.detail(args.shotId),
        }),
        queryClient.invalidateQueries({
          queryKey: shotKeys.list(args.sequenceId),
        }),
        queryClient.invalidateQueries({ queryKey: shotStalenessNamespace }),
      ]);
    },
  });
}

/** Music analog of `useRestoreShotPromptVariant`. */
export function useRestoreMusicPromptVariant(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, string>({
    mutationFn: (variantId) =>
      restoreSequenceMusicPromptVariantFn({
        data: { sequenceId, variantId },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: promptVariantKeys.music(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
      ]);
    },
  });
}
