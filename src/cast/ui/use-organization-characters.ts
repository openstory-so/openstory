/**
 * The organization's characters (#2017): the Characters page list, one character
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
  createOrganizationCharacterFn,
  updateOrganizationCharacterFn,
  getOrganizationCharacterFn,
  getOrganizationCharacterShotCountsFn,
  listOrganizationCharactersFn,
  deleteOrganizationCharacterFn,
  restoreOrganizationCharacterFn,
} from '@/cast/organization-characters.fn';
import { attachLibraryCharacterFn } from '@/cast/sequence-characters.fn';
import { sequenceCharacterKeys } from '@/cast/ui/use-sequence-characters';

export const organizationCharacterKeys = {
  all: ['organization-characters'] as const,
  current: (id: string) =>
    [...organizationCharacterKeys.all, 'current', id] as const,
  list: () => [...organizationCharacterKeys.all, 'list'] as const,
  detail: (id: string) =>
    [...organizationCharacterKeys.all, 'detail', id] as const,
  shotCounts: (id: string) =>
    [...organizationCharacterKeys.all, 'shot-counts', id] as const,
};

/** The organization's characters, sorted by use. Signed-in only. */
export function useOrganizationCharacters() {
  return useSuspenseQuery({
    queryKey: organizationCharacterKeys.list(),
    queryFn: () => listOrganizationCharactersFn(),
    staleTime: 30_000,
  });
}

/**
 * The organization's characters for the `@` picker (#2050): never suspends the
 * composer, and asks nothing while signed out.
 */
export function useLibraryCharacters(enabled: boolean) {
  return useQuery({
    queryKey: organizationCharacterKeys.list(),
    queryFn: () => listOrganizationCharactersFn(),
    staleTime: 30_000,
    enabled,
  });
}

export function useOrganizationCharacter(characterId: string) {
  return useSuspenseQuery({
    queryKey: organizationCharacterKeys.detail(characterId),
    queryFn: () => getOrganizationCharacterFn({ data: { characterId } }),
    staleTime: 30_000,
  });
}

/** Shots the character is in, per sequence. Its own page only. */
export function useOrganizationCharacterShotCounts(characterId: string) {
  return useSuspenseQuery({
    queryKey: organizationCharacterKeys.shotCounts(characterId),
    queryFn: () =>
      getOrganizationCharacterShotCountsFn({ data: { characterId } }),
    staleTime: 60_000,
  });
}

/** Bible fields a form posts; `''` clears a nullable field server-side. */
type OrganizationBibleInput = {
  age?: string;
  gender?: string;
  ethnicity?: string;
  physicalDescription?: string;
  standardClothing?: string;
  personality?: string;
  movement?: string;
  rendering?: string;
  voiceDescription?: string;
};

/** Make a character with no sequence (#2065). The caller shows the failure. */
export function useCreateOrganizationCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: { name: string; rendering: string } & OrganizationBibleInput
    ) => createOrganizationCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
    },
  });
}

/** Edit the bible from no sequence. The form shows the failure. */
export function useUpdateOrganizationCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: {
        characterId: string;
        name: string;
        voiceOnly: boolean;
        isPerson?: boolean;
      } & OrganizationBibleInput
    ) => updateOrganizationCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
    },
  });
}

/** Delete a character no sequence casts. Its own page shows the failure. */
export function useDeleteOrganizationCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { characterId: string }) =>
      deleteOrganizationCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
    },
  });
}

/** Undo a delete, from its toast. */
export function useRestoreOrganizationCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { globalError: true },
    mutationFn: (data: { characterId: string }) =>
      restoreOrganizationCharacterFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
    },
  });
}

/**
 * Cast an organization character into a sequence (#2050). The sequence's cast and
 * the organization list (sort and sequence counts) both move.
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
      void queryClient.invalidateQueries({
        queryKey: organizationCharacterKeys.all,
      });
    },
  });
}

/** The character's name for a breadcrumb: never suspends the header. */
export function useOrganizationCharacterName(characterId: string) {
  return useQuery({
    queryKey: organizationCharacterKeys.detail(characterId),
    queryFn: () => getOrganizationCharacterFn({ data: { characterId } }),
    staleTime: 30_000,
    select: (character) => character?.name,
  });
}
