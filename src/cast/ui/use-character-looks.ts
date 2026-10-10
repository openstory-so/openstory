/**
 * Mutations for a character's looks (#2015). Each refreshes the cast list
 * (looks ride on the character), the sheet queries and shot staleness: a
 * look edit re-stales its sheet and the shots of the scenes that wear it.
 *
 * `sequenceId` null is the Characters page editing a character no sequence
 * casts (#2065): the write goes to the team fns and no pin moves.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import {
  createCharacterLookFn,
  removeCharacterLookFn,
  restoreCharacterLookFn,
  updateCharacterLookFn,
} from '@/cast/character-looks.fn';
import {
  createTeamCharacterLookFn,
  removeTeamCharacterLookFn,
  restoreTeamCharacterLookFn,
  updateTeamCharacterLookFn,
} from '@/cast/team-characters.fn';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';
import { teamCharacterKeys } from '@/cast/ui/use-team-characters';
import { shotStalenessNamespace } from '@/shots/ui/use-shot-staleness';

type LookRef = {
  sequenceId: string | null;
  characterId: string;
  lookId: string;
};
type LookFields = {
  name: string;
  clothing: string | null;
  styling: string | null;
};

/**
 * Resolves once the cast list has refetched, so a caller's own `onSuccess`
 * (which runs after the hook's) sees the new look in it.
 */
async function refresh(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    queryKey: ['character-sheet-variants'],
  });
  void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
  void queryClient.invalidateQueries({ queryKey: teamCharacterKeys.all });
  await queryClient.invalidateQueries({ queryKey: sequenceCharacterKeys.all });
}

export function useCreateCharacterLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      sequenceId,
      ...look
    }: Omit<LookRef, 'lookId'> & LookFields) =>
      sequenceId === null
        ? createTeamCharacterLookFn({ data: look })
        : createCharacterLookFn({ data: { sequenceId, ...look } }),
    onSuccess: () => refresh(queryClient),
  });
}

export function useUpdateCharacterLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sequenceId, ...look }: LookRef & Partial<LookFields>) =>
      sequenceId === null
        ? updateTeamCharacterLookFn({ data: look })
        : updateCharacterLookFn({ data: { sequenceId, ...look } }),
    onSuccess: () => refresh(queryClient),
  });
}

export function useRemoveCharacterLook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sequenceId, ...look }: LookRef) =>
      sequenceId === null
        ? removeTeamCharacterLookFn({ data: look })
        : removeCharacterLookFn({ data: { sequenceId, ...look } }),
    onSuccess: () => refresh(queryClient),
  });
}

/** Undo for the remove toast: works on the app-level query client. */
export async function restoreCharacterLook(
  queryClient: QueryClient,
  { sequenceId, ...look }: LookRef
) {
  await (sequenceId === null
    ? restoreTeamCharacterLookFn({ data: look })
    : restoreCharacterLookFn({ data: { sequenceId, ...look } }));
  await refresh(queryClient);
}
