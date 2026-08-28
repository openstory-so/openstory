/**
 * Hook for fetching sequence locations
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  createSequenceLocationFn,
  getShotIdsForLocationFn,
  getSequenceLocationsFn,
  getTeamLocationsLibraryFn,
  getLocationSheetStalenessFn,
  recastLocationFn,
  regenerateLocationSheetFn,
  restoreSequenceLocationFn,
  softDeleteSequenceLocationFn,
  updateSequenceLocationFn,
} from '@/functions/sequence-locations';
import type { SheetStaleness } from '@/lib/sheets/sheet-staleness';
import { shotStalenessNamespace } from '@/hooks/use-shot-staleness';
import {
  getPublicLibraryLocationsFn,
  getTeamLibraryLocationsFn,
} from '@/functions/location-library';
import { usePublicOrTeamQuery } from '@/hooks/use-public-or-team-query';
import type { LibraryLocation, SequenceLocation } from '@/lib/db/schema';

// Re-export for backwards compatibility
export type { SequenceLocation };
export type { LibraryLocation };

// Extended type for team library locations (sequence locations with title)
export type TeamLibraryLocation = SequenceLocation & { sequenceTitle: string };

export const sequenceLocationKeys = {
  all: ['sequence-locations'] as const,
  list: (sequenceId: string) =>
    [...sequenceLocationKeys.all, 'list', sequenceId] as const,
  shotsForLocation: (sequenceId: string, locationId: string) =>
    [...sequenceLocationKeys.all, 'shots', sequenceId, locationId] as const,
  teamLibrary: ['team-locations-library'] as const,
  sheetStaleness: (sequenceId: string, locationDbId: string) =>
    [
      ...sequenceLocationKeys.all,
      'sheet-staleness',
      sequenceId,
      locationDbId,
    ] as const,
};

export const libraryLocationKeys = {
  all: ['library-locations'] as const,
  list: ['library-locations', 'list'] as const,
  publicList: ['library-locations', 'list', 'public'] as const,
};

export function useSequenceLocations(sequenceId: string) {
  return useQuery<SequenceLocation[]>({
    queryKey: sequenceLocationKeys.list(sequenceId),
    queryFn: async () => {
      return getSequenceLocationsFn({ data: { sequenceId } });
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - locations don't change often
    enabled: !!sequenceId,
  });
}

/**
 * Hook to get all sequence locations with completed references across the team
 * Used for recasting locations
 */
export function useTeamLocationsLibrary() {
  return useQuery<TeamLibraryLocation[]>({
    queryKey: sequenceLocationKeys.teamLibrary,
    queryFn: async () => {
      return getTeamLocationsLibraryFn();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get all library locations for the team
 * These are user-created location templates
 */
export function useLibraryLocations() {
  // Authenticated users get their team's locations plus public ("system")
  // ones; anonymous visitors get the public catalogue so they can browse and
  // pick system locations on the public new-sequence screen and locations page.
  return usePublicOrTeamQuery<LibraryLocation[]>({
    teamKey: libraryLocationKeys.list,
    publicKey: libraryLocationKeys.publicList,
    teamFn: () => getTeamLibraryLocationsFn(),
    publicFn: () => getPublicLibraryLocationsFn(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get the count of shots at a location
 * Used to show affected shots before recasting
 */
export function useShotIdsForLocation(sequenceId: string, locationId: string) {
  return useQuery({
    queryKey: sequenceLocationKeys.shotsForLocation(sequenceId, locationId),
    queryFn: () =>
      getShotIdsForLocationFn({ data: { sequenceId, locationId } }),
    enabled: !!sequenceId && !!locationId,
    staleTime: 60 * 1000, // 1 minute
  });
}

/** Editable bible fields; `''` clears a nullable field server-side. */
type LocationBibleInput = {
  type?: 'interior' | 'exterior' | 'both';
  timeOfDay?: string;
  description?: string;
  architecturalStyle?: string;
  keyFeatures?: string;
  colorPalette?: string;
  lightingSetup?: string;
  ambiance?: string;
};

/** Manual location create (#1108 Phase 2) — reference-less until recast. */
export function useCreateSequenceLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: { sequenceId: string; name: string } & LocationBibleInput
    ) => createSequenceLocationFn({ data }),
    onSuccess: (_location, { sequenceId }) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceLocationKeys.list(sequenceId),
      });
    },
  });
}

/**
 * Bible field edit (#1108 Phase 2). Prompts and the location reference that
 * project the edited fields re-stale by hash derivation, so the staleness
 * namespace refetches for the dots to appear.
 */
export function useUpdateSequenceLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: {
        sequenceId: string;
        locationDbId: string;
        name?: string;
      } & LocationBibleInput
    ) => updateSequenceLocationFn({ data }),
    onSuccess: (_location, { sequenceId }) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceLocationKeys.list(sequenceId),
      });
      void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
      void queryClient.invalidateQueries({
        queryKey: sequenceLocationKeys.all,
      });
    },
  });
}

export function useLocationSheetStaleness(
  sequenceId: string,
  locationDbId: string
) {
  return useQuery<SheetStaleness>({
    queryKey: sequenceLocationKeys.sheetStaleness(sequenceId, locationDbId),
    queryFn: () =>
      getLocationSheetStalenessFn({ data: { sequenceId, locationDbId } }),
    enabled: !!sequenceId && !!locationDbId,
    staleTime: 15_000,
  });
}

export function useRegenerateLocationSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      sequenceId: string;
      locationDbId: string;
      imageModel?: string;
    }) => regenerateLocationSheetFn({ data }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sequenceLocationKeys.all,
      });
      void queryClient.invalidateQueries({
        queryKey: ['location-sheet-variants'],
      });
      void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
    },
  });
}

/** Soft-remove / restore (#1108 Phase 2) — see the character analogs. */
export function useSoftDeleteSequenceLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { sequenceId: string; locationDbId: string }) =>
      softDeleteSequenceLocationFn({ data }),
    onSuccess: (_result, { sequenceId }) =>
      invalidateLocationMembership(queryClient, sequenceId),
  });
}

/**
 * Restore is a plain async, not a hook — see `restoreSequenceCharacter` for
 * why (undo-toast closures outlive the removing component).
 */
export async function restoreSequenceLocation(
  queryClient: QueryClient,
  data: { sequenceId: string; locationDbId: string }
): Promise<void> {
  await restoreSequenceLocationFn({ data });
  invalidateLocationMembership(queryClient, data.sequenceId);
}

function invalidateLocationMembership(
  queryClient: QueryClient,
  sequenceId: string
): void {
  void queryClient.invalidateQueries({
    queryKey: sequenceLocationKeys.list(sequenceId),
  });
  void queryClient.invalidateQueries({ queryKey: ['scene-facets'] });
  void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
}

/**
 * Hook for recasting a location with a library location reference
 */
export function useRecastLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      locationId: string;
      libraryLocationId: string;
      referenceImageUrl: string;
      description?: string;
    }) => recastLocationFn({ data }),
    onSuccess: () => {
      // Invalidate sequence locations to refresh the list
      void queryClient.invalidateQueries({
        queryKey: sequenceLocationKeys.all,
      });
      // Invalidate shots that are at this location
      void queryClient.invalidateQueries({ queryKey: ['shots'] });
    },
  });
}
