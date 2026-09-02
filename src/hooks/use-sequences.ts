import {
  addModelToSequenceFn,
  archiveSequenceFn,
  createSequenceFn,
  getArchivedSequencesFn,
  getSequenceAudioVariantsFn,
  getSequenceFn,
  getSequencesFn,
  renameSequenceFn,
  setSequenceModelFn,
  setSequenceMusicFn,
  unarchiveSequenceFn,
  type AddModelResult,
} from '@/functions/sequences';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import type { SequenceMusicVariant } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/shot-variants';
import { type CreateSequenceInput } from '@/lib/schemas/sequence.schemas';
import { UNTITLED_SEQUENCE_TITLE } from '@/lib/sequences/untitled-sequence-title';
import type { Sequence } from '@/types/database';
import { useAuthSession } from '@/lib/auth/session-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePostHog } from '@posthog/react';
import { toast } from 'sonner';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-sequences']);

// Query keys
export const sequenceKeys = {
  all: ['sequences'] as const,
  lists: () => [...sequenceKeys.all, 'list'] as const,
  list: (teamId?: string) => [...sequenceKeys.lists(), teamId] as const,
  details: () => [...sequenceKeys.all, 'detail'] as const,
  detail: (id?: string) => [...sequenceKeys.details(), id] as const,
};

/**
 * Music-prompt staleness — its own key rather than a member of
 * `sequenceKeys`, since it is a computed verdict rather than a slice of the
 * sequence row and must not be swept by a `sequenceKeys.all` invalidation.
 * Shared with the realtime cache updater, which refreshes it when a
 * generation run ends and its verdict becomes computable again (#1121).
 */
export const musicPromptStalenessKey = (sequenceId: string) =>
  ['music-prompt-staleness', sequenceId] as const;

// All music variant rows for a sequence (#546). Used by the music tab to
// resolve playback through the active model's track.
export function useSequenceAudioVariants(sequenceId?: string) {
  return useQuery<SequenceMusicVariant[]>({
    queryKey: ['sequence-audio-variants', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceAudioVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

const MODEL_LIST_KEY: Record<VariantType, (id: string) => string[]> = {
  image: (id) => ['sequence-image-models', id],
  video: (id) => ['sequence-video-models', id],
  audio: (id) => ['sequence-audio-models', id],
};
const VARIANTS_KEY: Record<VariantType, (id: string) => string[]> = {
  image: (id) => ['sequence-image-variants', id],
  video: (id) => ['sequence-video-variants', id],
  audio: (id) => ['sequence-audio-variants', id],
};

// Add a new model to an existing sequence (#547): generates its output for
// every shot (image/video) or the whole sequence (audio) using existing
// prompts. Invalidates the matching model-list + variants queries so the new
// model surfaces in the header dropdown immediately (pre-stamped pending).
export function useAddModelToSequence() {
  const queryClient = useQueryClient();
  return useMutation<
    AddModelResult,
    Error,
    { sequenceId: string; variantType: VariantType; model: string }
  >({
    mutationFn: async (input) => addModelToSequenceFn({ data: input }),
    onSuccess: async (_, { sequenceId, variantType }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: MODEL_LIST_KEY[variantType](sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: VARIANTS_KEY[variantType](sequenceId),
        }),
      ]);
    },
  });
}

/**
 * Promote a model to the live primary across the whole sequence (#547) — the
 * sequence-wide "Set". Invalidates the model list + variants (so the dropdown's
 * ⊙ primary marker moves) and the shots list (the primary image/video changed,
 * and an image Set also reset each shot's video).
 */
export function useSetSequenceModel() {
  const queryClient = useQueryClient();
  return useMutation<
    { count: number; variantType: 'image' | 'video'; model: string },
    Error,
    { sequenceId: string; variantType: 'image' | 'video'; model: string }
  >({
    mutationFn: async (input) => setSequenceModelFn({ data: input }),
    onSuccess: async (_, { sequenceId, variantType }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: MODEL_LIST_KEY[variantType](sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: VARIANTS_KEY[variantType](sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: ['shots', 'list', sequenceId],
        }),
        // This repoints the selection on EVERY frame / segment in the sequence,
        // which is what the editor resolves its model from (#1066).
        queryClient.invalidateQueries({
          queryKey: ['sequence-selected-models', sequenceId],
        }),
      ]);
    },
  });
}

// Hook for listing sequences. The app shell is anonymous-browsable but the
// fn requires auth, so don't fire (and error-log) it without a session (#1333).
export function useSequences(teamId?: string) {
  const { data: session } = useAuthSession();
  return useQuery<Sequence[]>({
    queryKey: sequenceKeys.list(teamId),
    queryFn: async () => {
      return getSequencesFn();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!session,
  });
}

// Hook for getting single sequence
export function useSequence(
  id?: string,
  options?: {
    refetchInterval?:
      | number
      | false
      | ((query: { state: { data: Sequence | undefined } }) => number | false);
    staleTime?: number;
  }
) {
  const { data: session } = useAuthSession();
  return useQuery<Sequence>({
    queryKey: sequenceKeys.detail(id),
    queryFn: async () => {
      if (!id) throw new Error('sequenceId is required');
      return await getSequenceFn({ data: { sequenceId: id } });
    },
    throwOnError: true,
    staleTime: options?.staleTime ?? 1000,
    enabled: !!id && !!session,
    refetchInterval: options?.refetchInterval ?? false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

// Hook for creating sequence (supports multi-model selection)
export function useCreateSequence() {
  const queryClient = useQueryClient();

  return useMutation<
    { data: Sequence[]; message?: string },
    Error,
    CreateSequenceInput
  >({
    mutationFn: async (input) => {
      const sequences = await createSequenceFn({
        data: {
          script: input.script,
          styleId: input.styleId,
          title: input.title || UNTITLED_SEQUENCE_TITLE,
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          analysisModels: input.analysisModels || [DEFAULT_ANALYSIS_MODEL],
          teamId: input.teamId,
          aspectRatio: input.aspectRatio,
          imageModels: input.imageModels,
          videoModel: input.videoModel,
          // Forward the multi-model arrays — without these the server only ever
          // sees the singular primary and resolveVideoModels/resolveAudioModels
          // collapse the user's selection to one model (#545/#546).
          videoModels: input.videoModels,
          autoGenerateMotion: input.autoGenerateMotion,
          autoGenerateMusic: input.autoGenerateMusic,
          musicModel: input.musicModel,
          audioModels: input.audioModels,
          targetDurationSeconds: input.targetDurationSeconds,
          suggestedTalentIds: input.suggestedTalentIds,
          suggestedLocationIds: input.suggestedLocationIds,
          elementUploads: input.elementUploads,
          sourceSequenceId: input.sourceSequenceId,
        },
      });

      return {
        data: sequences,
        message: 'Sequence created successfully',
      };
    },
    onSuccess: () => {
      queryClient
        .invalidateQueries({ queryKey: sequenceKeys.lists() })
        .catch((error) => {
          logger.error('Error invalidating sequences list on success:', {
            err: error,
          });
        });
    },
    // A silent failure here is what produced 9 identical resubmissions in
    // #1259 — always tell the user why nothing happened.
    onError: (error) => {
      toast.error(error.message || 'Generation failed to start.');
    },
  });
}

/** Archived sequences for the team (#1108 Phase 4). */
export function useArchivedSequences() {
  return useQuery<Sequence[]>({
    queryKey: ['archived-sequences'],
    queryFn: () => getArchivedSequencesFn(),
    staleTime: 60_000,
  });
}

/** Archive (soft "delete" per plan) — undone via useUnarchiveSequence. */
export function useArchiveSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sequenceId: string) =>
      archiveSequenceFn({ data: { sequenceId } }),
    onSuccess: () => invalidateSequenceLists(queryClient),
  });
}

/** Restore an archived sequence to its recorded prior status. */
export function useUnarchiveSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sequenceId: string) =>
      unarchiveSequenceFn({ data: { sequenceId } }),
    onSuccess: () => invalidateSequenceLists(queryClient),
  });
}

function invalidateSequenceLists(
  queryClient: ReturnType<typeof useQueryClient>
): void {
  void queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() });
  void queryClient.invalidateQueries({ queryKey: ['archived-sequences'] });
  // The eval matrix joins shots per listed sequence — refresh its join too.
  void queryClient.invalidateQueries({ queryKey: ['shots', 'by-sequences'] });
}

/**
 * Rename a sequence (#1108 Phase 4) — title-only write via the dedicated
 * `renameSequenceFn` (never `updateSequenceFn`, whose aspect-ratio handling
 * makes it unsafe for partial writes). Refreshes the detail (breadcrumb +
 * header) and the sequences list.
 */
export function useRenameSequence(sequenceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (title: string) =>
      renameSequenceFn({ data: { sequenceId, title } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(sequenceKeys.detail(sequenceId), updated);
      void queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });
      void queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() });
    },
  });
}

/**
 * Persist the per-sequence "include music in playback + export" toggle (#834).
 * Shared by the theatre player's music button and the music tab's checkbox.
 * Optimistically patches the sequence detail cache so the live player's music
 * gain and the next export react instantly; rolls back if the write fails.
 */
export function useSetSequenceMusic(sequenceId: string) {
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  return useMutation({
    // Serialize per-sequence writes so a quick off→on double-toggle can't have
    // its two POSTs resolve out of order and persist the stale value (#834).
    scope: { id: `set-sequence-music-${sequenceId}` },
    mutationFn: (includeMusic: boolean) =>
      setSequenceMusicFn({ data: { sequenceId, includeMusic } }),
    onMutate: async (includeMusic) => {
      const key = sequenceKeys.detail(sequenceId);
      // Cancel in-flight reads before patching: this query refetches on mount
      // and window focus and is invalidated by the generation stream, so an
      // outstanding refetch could otherwise resolve with the stale row and
      // silently flip the toggle back (#834).
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Sequence>(key);
      queryClient.setQueryData<Sequence>(key, (old) =>
        old ? { ...old, includeMusic } : old
      );
      return { previous };
    },
    onError: (error, _includeMusic, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(sequenceKeys.detail(sequenceId), ctx.previous);
      }
      toast.error('Could not save the music setting.');
      posthog.captureException(error, { sequence_id: sequenceId });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(sequenceKeys.detail(sequenceId), updated);
      // Capture only on confirmed persistence so the metric isn't inflated by
      // toggles that later roll back.
      posthog.capture('sequence_music_toggled', {
        sequence_id: sequenceId,
        include_music: updated.includeMusic,
      });
    },
    onSettled: () => {
      // Reconcile against the server's true state once the write settles.
      void queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });
    },
  });
}
