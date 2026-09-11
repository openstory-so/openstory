import {
  discardLibraryLocationSheetVariantFn,
  getLibraryLocationDivergentVariantsFn,
  promoteLibraryLocationSheetVariantFn,
  undiscardLibraryLocationSheetVariantFn,
} from '@/cast/library-location-sheet-variants.fn';
import { libraryLocationKeys } from './use-sequence-locations';
import { useUser } from '@/platform/ui/use-user';
import type { LocationSheetVariant } from '@/platform/server/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const libraryLocationSheetVariantKeys = {
  all: ['library-location-sheet-variants'] as const,
  divergent: () =>
    [...libraryLocationSheetVariantKeys.all, 'divergent'] as const,
};

/**
 * Active divergent variants across the team's library locations. Drives the
 * corner-dot indicator on `location-library-card` and the banner inside
 * `edit-location-dialog` (filtered by location id at the call site).
 */
export function useLibraryLocationDivergentVariants(options?: {
  refetchInterval?: number | false;
}) {
  const { data: user } = useUser();

  return useQuery<LocationSheetVariant[]>({
    queryKey: libraryLocationSheetVariantKeys.divergent(),
    queryFn: () => getLibraryLocationDivergentVariantsFn(),
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
    enabled: !!user,
  });
}

type VariantInput = { variantId: string };

export function usePromoteLibraryLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { inlineError: true },
    mutationFn: async (input: VariantInput) =>
      promoteLibraryLocationSheetVariantFn({ data: input }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: libraryLocationSheetVariantKeys.divergent(),
        }),
        // Promote rewrites the live `referenceImageUrl` — invalidate every
        // library/team library list so the new image appears.
        queryClient.invalidateQueries({ queryKey: libraryLocationKeys.all }),
      ]);
    },
  });
}

export function useDiscardLibraryLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantInput
  >({
    meta: { inlineError: true },
    mutationFn: async (input) =>
      discardLibraryLocationSheetVariantFn({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: libraryLocationSheetVariantKeys.divergent(),
      });
    },
  });
}

export function useUndiscardLibraryLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantInput>({
    meta: { inlineError: true },
    mutationFn: async (input) =>
      undiscardLibraryLocationSheetVariantFn({ data: input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: libraryLocationSheetVariantKeys.divergent(),
      });
    },
  });
}
