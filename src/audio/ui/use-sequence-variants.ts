import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  discardSequenceMusicVariantFn,
  getDivergentSequenceMusicVariantsFn,
  getOrganizationDivergentSequenceVariantsFn,
  promoteSequenceMusicVariantFn,
  setMusicFromVariantFn,
  undiscardSequenceMusicVariantFn,
} from '@/audio/sequence-variants.fn';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import type { SequenceMusicVariant } from '@/platform/server/db/schema';
import type { Sequence } from '@/platform/server/db/schema';

/**
 * Query-key factory for sequence-level music variants. The strings here match
 * the ones the realtime `query-cache-updater` invalidates on
 * `generation.stale:detected` events with `entityType: 'sequence'`.
 */
export const sequenceVariantKeys = {
  all: ['sequence-variants'] as const,
  divergentMusic: (sequenceId: string) =>
    ['sequence-divergent-music', sequenceId] as const,
  divergentByOrganization: (organizationId?: string) =>
    ['sequence-divergent-by-organization', organizationId ?? null] as const,
};

// ── Read hooks ─────────────────────────────────────────────────────────────

export function useSequenceDivergentMusicVariants(
  sequenceId?: string,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<SequenceMusicVariant[]>({
    queryKey: sequenceVariantKeys.divergentMusic(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getDivergentSequenceMusicVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/**
 * Aggregate read for the organization's sequences-list dashboard. Returns one row per
 * sequence that has at least one live divergent music alternate. The `enabled`
 * arg should be true once the organization dashboard has loaded; the server function
 * uses the session's active organization.
 */
export function useOrganizationDivergentSequenceVariants(enabled = true) {
  return useQuery<Array<{ sequenceId: string; hasMusic: boolean }>>({
    queryKey: sequenceVariantKeys.divergentByOrganization(),
    queryFn: () => getOrganizationDivergentSequenceVariantsFn(),
    enabled,
    staleTime: 30_000,
  });
}

// ── Mutations: music ────────────────────────────────────────────────────────

type VariantMutationInput = { sequenceId: string; variantId: string };

export function usePromoteSequenceMusicVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { sequence: Sequence; variantId: string },
    Error,
    VariantMutationInput
  >({
    mutationFn: async (input) => promoteSequenceMusicVariantFn({ data: input }),
    onSuccess: async ({ sequence }, { sequenceId }) => {
      queryClient.setQueryData(sequenceKeys.detail(sequenceId), sequence);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentMusic(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentByOrganization(),
        }),
      ]);
    },
  });
}

/**
 * "Set Music": switch the sequence's live primary track to a chosen model
 * (#546). Non-destructive — the per-sequence analog of `useSetVideoFromVariant`.
 */
export function useSetMusicFromVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { sequence: Sequence; model: string },
    Error,
    { sequenceId: string; model: string }
  >({
    mutationFn: async (input) => setMusicFromVariantFn({ data: input }),
    onSuccess: async ({ sequence }, { sequenceId }) => {
      queryClient.setQueryData(sequenceKeys.detail(sequenceId), sequence);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-audio-models', sequenceId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-audio-variants', sequenceId],
        }),
      ]);
    },
  });
}

export function useDiscardSequenceMusicVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantMutationInput
  >({
    mutationFn: async (input) => discardSequenceMusicVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentMusic(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentByOrganization(),
        }),
      ]);
    },
  });
}

export function useUndiscardSequenceMusicVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantMutationInput>({
    mutationFn: async (input) =>
      undiscardSequenceMusicVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentMusic(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentByOrganization(),
        }),
      ]);
    },
  });
}
