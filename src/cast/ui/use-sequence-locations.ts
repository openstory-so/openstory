/**
 * Locations as a sequence uses them (#1695): the sequence's list, the one
 * location a detail view shows (through a sequence or from none), and the
 * writes made through a sequence. The team's own list and writes are in
 * `use-team-locations.ts`.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  attachLocationFn,
  createSequenceLocationFn,
  getLocationFn,
  getShotIdsForLocationFn,
  getSequenceLocationsFn,
  getLocationSheetStalenessFn,
  recastLocationFn,
  regenerateLocationSheetFn,
  restoreSequenceLocationFn,
  softDeleteSequenceLocationFn,
  updateSequenceLocationFn,
} from '@/cast/sequence-locations.fn';
import type { SheetStaleness } from '@/cast/server/sheets/sheet-staleness';
import {
  invalidateLocations,
  sequenceLocationKeys,
} from '@/cast/ui/location-keys';
import type { SequenceLocationWithReference } from '@/platform/server/db/schema';

export { sequenceLocationKeys };
export type { SequenceLocationWithReference };

export function useSequenceLocations(sequenceId: string) {
  return useQuery<SequenceLocationWithReference[]>({
    queryKey: sequenceLocationKeys.list(sequenceId),
    queryFn: async () => {
      return getSequenceLocationsFn({ data: { sequenceId } });
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - locations don't change often
    enabled: !!sequenceId,
  });
}

/**
 * One location at its current version, read from no sequence (the Locations
 * page). Null when it is gone or another team's. Through a sequence the
 * detail view uses the sequence list's row instead.
 */
export function useTeamLocationCurrent(locationDbId: string, enabled: boolean) {
  return useQuery({
    queryKey: sequenceLocationKeys.detail(null, locationDbId),
    queryFn: () => getLocationFn({ data: { sequenceId: null, locationDbId } }),
    staleTime: 30_000,
    enabled,
  });
}

/**
 * Shots set at a location in one sequence: the count on its page and the
 * shots a Replace re-renders. Asks nothing from no sequence.
 */
export function useShotIdsForLocation(
  sequenceId: string | null,
  locationId: string
) {
  return useQuery({
    queryKey: sequenceLocationKeys.shotsForLocation(
      sequenceId ?? '',
      locationId
    ),
    queryFn: () =>
      getShotIdsForLocationFn({
        data: { sequenceId: sequenceId ?? '', locationId },
      }),
    enabled: !!sequenceId && !!locationId,
    staleTime: 60 * 1000, // 1 minute
  });
}

/** Editable bible fields; `''` clears a nullable field server-side. */
export type LocationBibleInput = {
  type?: 'interior' | 'exterior' | 'both';
  description?: string;
  architecturalStyle?: string;
  keyFeatures?: string;
  ambiance?: string;
  rendering?: string;
};

/** Manual location create (#1108 Phase 2): no sheet until Generate. */
export function useCreateSequenceLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: { sequenceId: string; name: string } & LocationBibleInput
    ) => createSequenceLocationFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/**
 * Use one of the team's locations in a sequence (#1695). The sequence's
 * locations and the team list (sort and sequence counts) both move.
 */
export function useAttachLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { sequenceId: string; locationId: string }) =>
      attachLocationFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/**
 * Bible field edit made through a sequence (#1108 Phase 2). The location is
 * the team's, so every sequence's sheet and prompts re-stale by hash
 * derivation.
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
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

export function useLocationSheetStaleness(
  sequenceId: string | null,
  locationDbId: string
) {
  return useQuery<SheetStaleness>({
    queryKey: sequenceLocationKeys.sheetStaleness(sequenceId, locationDbId),
    queryFn: () =>
      getLocationSheetStalenessFn({ data: { sequenceId, locationDbId } }),
    enabled: !!locationDbId,
    staleTime: 15_000,
  });
}

export function useRegenerateLocationSheet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      sequenceId: string | null;
      locationDbId: string;
      imageModel?: string;
    }) => regenerateLocationSheetFn({ data }),
    // Returned: pending until the location is re-read as `generating`.
    onSuccess: () => invalidateLocations(queryClient),
  });
}

/** Soft-remove / restore (#1108 Phase 2) — see the character analogs. */
export function useSoftDeleteSequenceLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { sequenceId: string; locationDbId: string }) =>
      softDeleteSequenceLocationFn({ data }),
    onSuccess: () => invalidateLocationMembership(queryClient),
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
  invalidateLocationMembership(queryClient);
}

function invalidateLocationMembership(queryClient: QueryClient): void {
  void invalidateLocations(queryClient);
  void queryClient.invalidateQueries({ queryKey: ['scene-facets'] });
}

/**
 * Replace a sequence's location with another of the team's (#1695): the link
 * is re-pointed and the shots set there re-render. No sheet is drawn.
 */
export function useRecastLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: { globalError: true },
    mutationFn: (data: {
      sequenceId: string;
      locationId: string;
      withLocationId: string;
    }) => recastLocationFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['scene-facets'] });
      void queryClient.invalidateQueries({ queryKey: ['shots'] });
    },
  });
}
