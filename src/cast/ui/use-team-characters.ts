/**
 * The team's characters (#2017): the Characters page list, one character
 * with the sequences that cast it, its delete, and the writes made with no
 * sequence (#2065).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  createTeamCharacterFn,
  getCurrentTeamCharacterFn,
  updateTeamCharacterFn,
  getTeamCharacterFn,
  getTeamCharacterShotCountsFn,
  listTeamCharactersFn,
  deleteTeamCharacterFn,
  restoreTeamCharacterFn,
} from '@/cast/team-characters.fn';
import { attachLibraryCharacterFn } from '@/cast/sequence-characters.fn';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';

export const teamCharacterKeys = {
  all: ['team-characters'] as const,
  current: (id: string) => [...teamCharacterKeys.all, 'current', id] as const,
  list: () => [...teamCharacterKeys.all, 'list'] as const,
  detail: (id: string) => [...teamCharacterKeys.all, 'detail', id] as const,
  shotCounts: (id: string) =>
    [...teamCharacterKeys.all, 'shot-counts', id] as const,
};

/** The team's characters, sorted by use. Signed-in only. */
export function useTeamCharacters() {
  return useSuspenseQuery({
    queryKey: teamCharacterKeys.list(),
    queryFn: () => listTeamCharactersFn(),
    staleTime: 30_000,
  });
}

/**
 * The team's characters for the `@` picker (#2050): never suspends the
 * composer, and asks nothing while signed out.
 */
export function useLibraryCharacters(enabled: boolean) {
  return useQuery({
    queryKey: teamCharacterKeys.list(),
    queryFn: () => listTeamCharactersFn(),
    staleTime: 30_000,
    enabled,
  });
}

export function useTeamCharacter(characterId: string) {
  return useSuspenseQuery({
    queryKey: teamCharacterKeys.detail(characterId),
    queryFn: () => getTeamCharacterFn({ data: { characterId } }),
    staleTime: 30_000,
  });
}

/** Shots the character is in, per sequence. Its own page only. */
export function useTeamCharacterShotCounts(characterId: string) {
  return useSuspenseQuery({
    queryKey: teamCharacterKeys.shotCounts(characterId),
    queryFn: () => getTeamCharacterShotCountsFn({ data: { characterId } }),
    staleTime: 60_000,
  });
}

/** Bible fields a form posts; `''` clears a nullable field server-side. */
type TeamBibleInput = {
  age?: string;
  gender?: string;
  ethnicity?: string;
  physicalDescription?: string;
  standardClothing?: string;
  personality?: string;
  movement?: string;
};

/** Make a character with no sequence (#2065). The caller shows the failure. */
export function useCreateTeamCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string } & TeamBibleInput) =>
      createTeamCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamCharacterKeys.all });
    },
  });
}

/**
 * The character at its current version, with its looks: what its page
 * edits while no sequence casts it (#2065).
 */
export function useCurrentTeamCharacter(characterId: string) {
  return useSuspenseQuery({
    queryKey: teamCharacterKeys.current(characterId),
    queryFn: () => getCurrentTeamCharacterFn({ data: { characterId } }),
    staleTime: 30_000,
  });
}

/** Edit the bible from no sequence. The form shows the failure. */
export function useUpdateTeamCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: {
        characterId: string;
        name: string;
        voiceOnly: boolean;
        isPerson?: boolean;
      } & TeamBibleInput
    ) => updateTeamCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamCharacterKeys.all });
    },
  });
}

/** Delete a character no sequence casts. Its own page shows the failure. */
export function useDeleteTeamCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { characterId: string }) =>
      deleteTeamCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamCharacterKeys.all });
    },
  });
}

/** Undo a delete, from its toast. */
export function useRestoreTeamCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { globalError: true },
    mutationFn: (data: { characterId: string }) =>
      restoreTeamCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamCharacterKeys.all });
    },
  });
}

/**
 * Cast a team character into a sequence (#2050). The sequence's cast and
 * the team list (sort and sequence counts) both move.
 */
export function useAttachLibraryCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { sequenceId: string; characterId: string }) =>
      attachLibraryCharacterFn({ data }),
    onSuccess: (_character, { sequenceId }) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.list(sequenceId),
      });
      void queryClient.invalidateQueries({ queryKey: teamCharacterKeys.all });
    },
  });
}

/** The character's name for a breadcrumb: never suspends the header. */
export function useTeamCharacterName(characterId: string) {
  return useQuery({
    queryKey: teamCharacterKeys.detail(characterId),
    queryFn: () => getTeamCharacterFn({ data: { characterId } }),
    staleTime: 30_000,
    select: (character) => character?.name,
  });
}
