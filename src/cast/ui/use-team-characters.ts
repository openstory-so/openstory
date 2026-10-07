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
  moveCharacterCastsFn,
  previewCharacterVersionMoveFn,
  setCharacterInLibraryFn,
} from '@/cast/team-characters.fn';
import { attachLibraryCharacterFn } from '@/cast/sequence-characters.fn';
import {
  invalidateAfterVersionMove,
  sequenceCharacterKeys,
} from '@/cast/ui/use-sequence-characters';

const teamCharacterKeys = {
  all: ['team-characters'] as const,
  list: (inLibrary: boolean) =>
    [...teamCharacterKeys.all, 'list', { inLibrary }] as const,
  detail: (id: string) => [...teamCharacterKeys.all, 'detail', id] as const,
  shotCounts: (id: string) =>
    [...teamCharacterKeys.all, 'shot-counts', id] as const,
  versionMove: (id: string) =>
    [...teamCharacterKeys.all, 'version-move', id] as const,
};

/**
 * The sequences casting a character, which are behind its current version,
 * and the upper-bound cost of moving each (#2017). Loads every behind
 * sequence's shots, so only while the dialog is open.
 */
export function useCharacterVersionMovePreview(
  characterId: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: teamCharacterKeys.versionMove(characterId),
    queryFn: () => previewCharacterVersionMoveFn({ data: { characterId } }),
    staleTime: 30_000,
    enabled,
  });
}

/** Move the chosen sequences to the character's current version. */
export function useMoveCharacterCasts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { characterId: string; sequenceIds: string[] }) =>
      moveCharacterCastsFn({ data }),
    onSuccess: (_result, { characterId, sequenceIds }) => {
      void queryClient.invalidateQueries({
        queryKey: teamCharacterKeys.versionMove(characterId),
      });
      for (const sequenceId of sequenceIds) {
        invalidateAfterVersionMove(queryClient, sequenceId);
      }
    },
  });
}

/** The team's characters, sorted by use. Signed-in only. */
export function useTeamCharacters(inLibrary: boolean) {
  return useSuspenseQuery({
    queryKey: teamCharacterKeys.list(inLibrary),
    queryFn: () => listTeamCharactersFn({ data: { inLibrary } }),
    staleTime: 30_000,
  });
}

/**
 * The library for the `@` picker (#2050): never suspends the composer, and
 * asks nothing while signed out.
 */
export function useLibraryCharacters(enabled: boolean) {
  return useQuery({
    queryKey: teamCharacterKeys.list(true),
    queryFn: () => listTeamCharactersFn({ data: { inLibrary: true } }),
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

/**
 * Cast a library character into a sequence (#2050). The sequence's cast and
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

/**
 * Whether a live sequence other than `sequenceId` casts the character: the
 * panel offers "Move sequences" only then, or when this one is behind. Never
 * suspends the panel.
 */
export function useCharacterCastElsewhere(
  characterId: string,
  sequenceId: string
) {
  return useQuery({
    queryKey: teamCharacterKeys.detail(characterId),
    queryFn: () => getTeamCharacterFn({ data: { characterId } }),
    staleTime: 30_000,
    select: (character) =>
      (character?.sequences ?? []).some((s) => s.id !== sequenceId),
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
