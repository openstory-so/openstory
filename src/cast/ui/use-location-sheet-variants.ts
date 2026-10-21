/**
 * A location's sheet versions (#1695). The sheets are the location's, so
 * every read and write here works through a sequence or from none
 * (`sequenceId: null`, the Locations page).
 */
import {
  discardLocationSheetVariantFn,
  getLocationDivergentVariantsFn,
  listLocationSheetVersionsFn,
  promoteLocationSheetVariantFn,
  selectLocationSheetVersionFn,
  undiscardLocationSheetVariantFn,
} from '@/cast/location-sheet-variants.fn';
import {
  invalidateLocations,
  locationSheetVariantKeys,
} from '@/cast/ui/location-keys';
import type { LocationSheetVariant } from '@/platform/server/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export { locationSheetVariantKeys };

export function useLocationSheetVersions(
  sequenceId: string | null,
  locationDbId: string
) {
  return useQuery({
    queryKey: locationSheetVariantKeys.history(sequenceId, locationDbId),
    queryFn: () =>
      listLocationSheetVersionsFn({ data: { sequenceId, locationDbId } }),
    enabled: !!locationDbId,
    staleTime: 15_000,
  });
}

export function useSelectLocationSheetVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      sequenceId: string | null;
      locationDbId: string;
      versionId: string;
    }) => selectLocationSheetVersionFn({ data: input }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/** One location's live divergent alternates: the detail view's banner. */
export function useLocationDivergentVariants(
  sequenceId: string | null,
  locationDbId: string
) {
  return useQuery<LocationSheetVariant[]>({
    queryKey: locationSheetVariantKeys.divergentByLocation(
      sequenceId,
      locationDbId
    ),
    queryFn: () =>
      getLocationDivergentVariantsFn({ data: { sequenceId, locationDbId } }),
    staleTime: 30_000,
  });
}

type VariantInput = { sequenceId: string | null; variantId: string };

export function usePromoteLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      promoteLocationSheetVariantFn({ data: input }),
    onSuccess: () => invalidateLocations(queryClient),
  });
}

export function useDiscardLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      discardLocationSheetVariantFn({ data: input }),
    onSuccess: () => invalidateLocations(queryClient),
  });
}

export function useUndiscardLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      undiscardLocationSheetVariantFn({ data: input }),
    onSuccess: () => invalidateLocations(queryClient),
  });
}
