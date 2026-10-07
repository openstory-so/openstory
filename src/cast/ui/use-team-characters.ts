/**
 * The team's characters (#2017): the Characters page list, one character
 * with the sequences that cast it, and the library flag.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  getTeamCharacterFn,
  getTeamCharacterShotCountsFn,
  listTeamCharactersFn,
  setCharacterInLibraryFn,
} from '@/cast/team-characters.fn';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';

const teamCharacterKeys = {
  all: ['team-characters'] as const,
  list: (inLibrary: boolean) =>
    [...teamCharacterKeys.all, 'list', { inLibrary }] as const,
  detail: (id: string) => [...teamCharacterKeys.all, 'detail', id] as const,
  shotCounts: (id: string) =>
    [...teamCharacterKeys.all, 'shot-counts', id] as const,
};

/** The team's characters, sorted by use. Signed-in only. */
export function useTeamCharacters(inLibrary: boolean) {
  return useSuspenseQuery({
    queryKey: teamCharacterKeys.list(inLibrary),
    queryFn: () => listTeamCharactersFn({ data: { inLibrary } }),
    staleTime: 30_000,
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

/** Put a character in the team library, or take it out. Nothing is copied. */
export function useSetCharacterInLibrary() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { globalError: true },
    mutationFn: (data: { characterId: string; inLibrary: boolean }) =>
      setCharacterInLibraryFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: teamCharacterKeys.all });
      // The flag rides on every cast read of the character.
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.all,
      });
    },
  });
}

/** The character's name for a breadcrumb: never suspends the header. */
export function useTeamCharacterName(characterId: string) {
  return useQuery({
    queryKey: teamCharacterKeys.detail(characterId),
    queryFn: () => getTeamCharacterFn({ data: { characterId } }),
    staleTime: 30_000,
    select: (character) => character.name,
  });
}
