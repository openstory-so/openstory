import {
  discardCharacterSheetVariantFn,
  getCharacterDivergentVariantsFn,
  listCharacterSheetVersionsFn,
  promoteCharacterSheetVariantFn,
  selectCharacterSheetVersionFn,
  undiscardCharacterSheetVariantFn,
} from '@/cast/character-sheet-variants.fn';
import { sequenceCharacterKeys } from './use-sequence-characters';
import { shotStalenessNamespace } from '@/shots/ui/use-shot-staleness';
import type { CharacterSheetVariant } from '@/platform/server/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/** Null is the Characters page (#2017): the same sheets, no sequence. */
const scope = (sequenceId: string | null) => sequenceId ?? 'team';

export const characterSheetVariantKeys = {
  all: ['character-sheet-variants'] as const,
  divergentBySequence: (sequenceId: string) =>
    [...characterSheetVariantKeys.all, 'sequence', sequenceId] as const,
  divergentByCharacter: (characterId: string) =>
    [...characterSheetVariantKeys.all, 'character', characterId] as const,
  history: (sequenceId: string | null, characterId: string) =>
    [
      ...characterSheetVariantKeys.all,
      'history',
      scope(sequenceId),
      characterId,
    ] as const,
};

/** One character's live divergent alternates: the detail view's banner. */
export function useCharacterOwnDivergentVariants(
  sequenceId: string | null,
  characterId: string
) {
  return useQuery<CharacterSheetVariant[]>({
    queryKey: characterSheetVariantKeys.divergentByCharacter(characterId),
    queryFn: () =>
      getCharacterDivergentVariantsFn({ data: { sequenceId, characterId } }),
    staleTime: 30_000,
  });
}

/** One look's sheet versions (#2015); the default look's when `lookId` is omitted. */
export function useCharacterSheetVersions(
  sequenceId: string | null,
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
    enabled: !!characterId,
    staleTime: 15_000,
  });
}

export function useSelectCharacterSheetVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      sequenceId: string | null;
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

type VariantInput = { sequenceId: string | null; variantId: string };

export function usePromoteCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      promoteCharacterSheetVariantFn({ data: input }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: characterSheetVariantKeys.all,
        }),
        // The promoted url overwrites characters.sheetImageUrl — invalidate
        // the upstream character reads so the live image swaps in the UI.
        queryClient.invalidateQueries({
          queryKey: sequenceCharacterKeys.all,
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: characterSheetVariantKeys.all,
      });
    },
  });
}

export function useUndiscardCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantInput>({
    mutationFn: async (input) =>
      undiscardCharacterSheetVariantFn({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: characterSheetVariantKeys.all,
      });
    },
  });
}
