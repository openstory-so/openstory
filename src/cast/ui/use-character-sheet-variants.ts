import {
  discardCharacterSheetVariantFn,
  getSequenceCharacterDivergentVariantsFn,
  listCharacterSheetVersionsFn,
  promoteCharacterSheetVariantFn,
  selectCharacterSheetVersionFn,
  undiscardCharacterSheetVariantFn,
  getSheetUpstreamChangesFn,
} from '@/cast/character-sheet-variants.fn';
import { sequenceCharacterKeys } from './use-sequence-characters';
import { shotStalenessNamespace } from '@/shots/ui/use-shot-staleness';
import type { CharacterSheetVariant } from '@/platform/server/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const characterSheetVariantKeys = {
  all: ['character-sheet-variants'] as const,
  divergentBySequence: (sequenceId: string) =>
    [...characterSheetVariantKeys.all, 'sequence', sequenceId] as const,
  history: (sequenceId: string, characterId: string) =>
    [
      ...characterSheetVariantKeys.all,
      'history',
      sequenceId,
      characterId,
    ] as const,
};

/** What moved since a parked sheet was drawn (#1862); read while the compare is open. */
export function useSheetUpstreamChanges(
  sequenceId: string,
  variantId: string | undefined
) {
  return useQuery<string[]>({
    queryKey: [...characterSheetVariantKeys.all, 'upstream', variantId ?? ''],
    queryFn: () => {
      if (!variantId) throw new Error('variantId is required');
      return getSheetUpstreamChangesFn({ data: { sequenceId, variantId } });
    },
    enabled: !!variantId,
    staleTime: 30_000,
  });
}

/**
 * Query the active divergent character-sheet alternates for every character
 * in a sequence. Drives the corner-dot indicator on talent cards and the
 * banner on the character detail view. Mirrors `useDivergentVariants`.
 */
export function useCharacterDivergentVariants(
  sequenceId: string | undefined,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<CharacterSheetVariant[]>({
    queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceCharacterDivergentVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/** One look's sheet versions (#2015); the default look's when `lookId` is omitted. */
export function useCharacterSheetVersions(
  sequenceId: string,
  characterId: string,
  lookId?: string
) {
  return useQuery({
    queryKey: [
      ...characterSheetVariantKeys.history(sequenceId, characterId),
      lookId ?? 'default',
    ],
    queryFn: () =>
      listCharacterSheetVersionsFn({
        data: { sequenceId, characterId, lookId },
      }),
    enabled: !!sequenceId && !!characterId,
    staleTime: 15_000,
  });
}

export function useSelectCharacterSheetVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      sequenceId: string;
      characterId: string;
      versionId: string;
    }) => selectCharacterSheetVersionFn({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: characterSheetVariantKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.all,
      });
      void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
    },
  });
}

type VariantInput = { sequenceId: string; variantId: string };

export function usePromoteCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      promoteCharacterSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId),
        }),
        // The promoted url overwrites characters.sheetImageUrl — invalidate
        // the upstream characters list so the live image swaps in the UI.
        queryClient.invalidateQueries({
          queryKey: sequenceCharacterKeys.list(sequenceId),
        }),
      ]);
    },
  });
}

export function useDiscardCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantInput
  >({
    mutationFn: async (input) =>
      discardCharacterSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId),
      });
    },
  });
}

export function useUndiscardCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantInput>({
    mutationFn: async (input) =>
      undiscardCharacterSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId),
      });
    },
  });
}
