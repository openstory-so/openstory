/**
 * Hook for fetching sequence characters
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  createSequenceCharacterFn,
  getCharacterSheetStalenessFn,
  getShotIdsForCharacterFn,
  getSequenceCharactersFn,
  recastCharacterFn,
  regenerateCharacterSheetFn,
  restoreSequenceCharacterFn,
  softDeleteSequenceCharacterFn,
  updateSequenceCharacterFn,
} from '@/functions/sequence-characters';
import type { SheetStaleness } from '@/lib/sheets/sheet-staleness';
import { addCharacterToLibraryFn } from '@/functions/talent';
import { shotStalenessNamespace } from '@/hooks/use-shot-staleness';
import type { CharacterWithTalent } from '@/lib/db/schema';

export const sequenceCharacterKeys = {
  all: ['sequence-characters'] as const,
  list: (sequenceId: string) =>
    [...sequenceCharacterKeys.all, 'list', sequenceId] as const,
  shotsForCharacter: (sequenceId: string, characterId: string) =>
    [...sequenceCharacterKeys.all, 'shots', sequenceId, characterId] as const,
  sheetStaleness: (sequenceId: string, characterId: string) =>
    [
      ...sequenceCharacterKeys.all,
      'sheet-staleness',
      sequenceId,
      characterId,
    ] as const,
};

export function useSequenceCharacters(sequenceId: string) {
  return useQuery<CharacterWithTalent[]>({
    queryKey: sequenceCharacterKeys.list(sequenceId),
    queryFn: async () => {
      return getSequenceCharactersFn({ data: { sequenceId } });
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - characters don't change often
    enabled: !!sequenceId,
  });
}

/**
 * Hook for adding a sequence character to the team's talent library
 */
export function useAddCharacterToLibrary() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (characterId: string) =>
      addCharacterToLibraryFn({ data: { characterId } }),
    onSuccess: () => {
      // Invalidate talent queries to refresh library
      void queryClient.invalidateQueries({ queryKey: ['talent'] });
    },
  });
}

/**
 * Hook to get the count of shots containing a character
 * Used to show affected shots before recasting
 */
export function useShotIdsForCharacter(
  sequenceId: string,
  characterId: string
) {
  return useQuery({
    queryKey: sequenceCharacterKeys.shotsForCharacter(sequenceId, characterId),
    queryFn: () =>
      getShotIdsForCharacterFn({ data: { sequenceId, characterId } }),
    enabled: !!sequenceId && !!characterId,
    staleTime: 60 * 1000, // 1 minute
  });
}

/** Editable bible fields; `''` clears a nullable field server-side. */
type CharacterBibleInput = {
  age?: string;
  gender?: string;
  ethnicity?: string;
  physicalDescription?: string;
  standardClothing?: string;
  distinguishingFeatures?: string;
};

/** Manual character create (#1108 Phase 2) — sheet-less until recast. */
export function useCreateSequenceCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: { sequenceId: string; name: string } & CharacterBibleInput
    ) => createSequenceCharacterFn({ data }),
    onSuccess: (_character, { sequenceId }) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.list(sequenceId),
      });
    },
  });
}

/**
 * Bible field edit (#1108 Phase 2). Prompts and the character sheet that
 * project the edited fields re-stale by hash derivation, so the staleness
 * namespace refetches for the dots to appear.
 */
export function useUpdateSequenceCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: {
        sequenceId: string;
        characterId: string;
        name?: string;
      } & CharacterBibleInput
    ) => updateSequenceCharacterFn({ data }),
    onSuccess: (_character, { sequenceId }) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.list(sequenceId),
      });
      void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.all,
      });
    },
  });
}

export function useCharacterSheetStaleness(
  sequenceId: string,
  characterId: string
) {
  return useQuery<SheetStaleness>({
    queryKey: sequenceCharacterKeys.sheetStaleness(sequenceId, characterId),
    queryFn: () =>
      getCharacterSheetStalenessFn({ data: { sequenceId, characterId } }),
    enabled: !!sequenceId && !!characterId,
    staleTime: 15_000,
  });
}

export function useRegenerateCharacterSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      sequenceId: string;
      characterId: string;
      imageModel?: string;
    }) => regenerateCharacterSheetFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: ['character-sheet-variants'],
      });
      void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
    },
  });
}

/**
 * Soft-remove / restore (#1108 Phase 2). Both refresh the cast list, facet
 * membership, and staleness — a removed character drops out of bible reads,
 * so prompts naming it read stale; restore reverses that.
 */
export function useSoftDeleteSequenceCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { sequenceId: string; characterId: string }) =>
      softDeleteSequenceCharacterFn({ data }),
    onSuccess: (_result, { sequenceId }) =>
      invalidateCastMembership(queryClient, sequenceId),
  });
}

/**
 * Restore is a plain async, not a hook: it runs from undo-toast closures that
 * outlive the component that removed the entity (Radix unmounts inactive tab
 * content; detail pages navigate away), where an unmounted mutation observer
 * could skip its callbacks. The app-level QueryClient stays valid.
 */
export async function restoreSequenceCharacter(
  queryClient: QueryClient,
  data: { sequenceId: string; characterId: string }
): Promise<void> {
  await restoreSequenceCharacterFn({ data });
  invalidateCastMembership(queryClient, data.sequenceId);
}

function invalidateCastMembership(
  queryClient: QueryClient,
  sequenceId: string
): void {
  void queryClient.invalidateQueries({
    queryKey: sequenceCharacterKeys.list(sequenceId),
  });
  void queryClient.invalidateQueries({ queryKey: ['scene-facets'] });
  void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
}

/**
 * Hook for recasting a character with a talent from the library
 */
export function useRecastCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { characterId: string; talentId: string }) =>
      recastCharacterFn({ data }),
    onSuccess: () => {
      // Invalidate sequence characters to refresh the list
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.all,
      });
      // Invalidate shots that contain this character
      void queryClient.invalidateQueries({ queryKey: ['shots'] });
    },
  });
}
