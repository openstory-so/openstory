/**
 * Mutations for a character's looks (#2015). Each refreshes the cast list
 * (looks ride on the character), the sheet queries and shot staleness: a
 * look edit re-stales its sheet and the shots of the scenes that wear it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  createCharacterLookFn,
  removeCharacterLookFn,
  restoreCharacterLookFn,
  updateCharacterLookFn,
} from '@/cast/character-looks.fn';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';
import { shotStalenessNamespace } from '@/shots/ui/use-shot-staleness';

type LookRef = { sequenceId: string; characterId: string; lookId: string };
type LookFields = {
  name: string;
  clothing: string | null;
  styling: string | null;
};

function refresh(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: sequenceCharacterKeys.all });
  void queryClient.invalidateQueries({
    queryKey: ['character-sheet-variants'],
  });
  void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
}

export function useCreateCharacterLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<LookRef, 'lookId'> & LookFields) =>
      createCharacterLookFn({ data }),
    onSuccess: () => refresh(queryClient),
  });
}

export function useUpdateCharacterLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: LookRef & Partial<LookFields>) =>
      updateCharacterLookFn({ data }),
    onSuccess: () => refresh(queryClient),
  });
}

export function useRemoveCharacterLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: LookRef) => removeCharacterLookFn({ data }),
    onSuccess: () => refresh(queryClient),
  });
}

/** Undo for the remove toast: works on the app-level query client. */
export async function restoreCharacterLook(
  queryClient: QueryClient,
  data: LookRef
) {
  await restoreCharacterLookFn({ data });
  refresh(queryClient);
}
