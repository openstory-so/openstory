/**
 * Hooks for location library operations — team-scoped for authenticated
 * users, plus public ("system") reads for anonymous visitors.
 */

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  addLocationSheetsFn,
  createLibraryLocationFn,
  deleteLibraryLocationFn,
  deleteLocationSheetFn,
  getLibraryLocationByIdFn,
  getPublicLibraryLocationByIdFn,
  presignLocationUploadFn,
  finalizeLocationUploadFn,
  updateLibraryLocationFn,
} from '@/functions/location-library';
import { usePublicOrTeamQuery } from '@/hooks/use-public-or-team-query';
import { putToR2 } from '@/shared/utils/upload';
import {
  libraryLocationKeys,
  sequenceLocationKeys,
} from '@/hooks/use-sequence-locations';
import type { LibraryLocation, LocationSheet } from '@/lib/db/schema';

/** Library location with sheets for detail view */
export type LibraryLocationWithSheets = LibraryLocation & {
  sequenceTitle: string; // For backwards compatibility - always 'Library' for library locations
  sheets: LocationSheet[];
};

/**
 * Query keys for location library
 */
export const locationLibraryKeys = {
  all: ['location-library'] as const,
  detail: (id: string) => [...locationLibraryKeys.all, 'detail', id] as const,
  publicDetail: (id: string) =>
    [...locationLibraryKeys.all, 'detail', 'public', id] as const,
};

/**
 * Invalidate all location-related queries.
 * Use after mutations that affect location data.
 */
function invalidateLocationQueries(
  queryClient: QueryClient,
  locationId?: string
): void {
  if (locationId) {
    void queryClient.invalidateQueries({
      queryKey: locationLibraryKeys.detail(locationId),
    });
  }
  void queryClient.invalidateQueries({ queryKey: libraryLocationKeys.all });
  void queryClient.invalidateQueries({
    queryKey: sequenceLocationKeys.teamLibrary,
  });
}

/**
 * Hook to fetch a single location with details and reference sheets. Anonymous
 * visitors get the public ("system") location so they can open a location
 * detail page read-only.
 */
export function useLibraryLocationById(locationId: string) {
  return usePublicOrTeamQuery<LibraryLocationWithSheets>({
    teamKey: locationLibraryKeys.detail(locationId),
    publicKey: locationLibraryKeys.publicDetail(locationId),
    teamFn: () => getLibraryLocationByIdFn({ data: { locationId } }),
    publicFn: () => getPublicLibraryLocationByIdFn({ data: { locationId } }),
    enabled: !!locationId,
  });
}

/**
 * Hook to create a new library location
 */
export function useCreateLibraryLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      referenceImageUrls?: string[];
    }) => createLibraryLocationFn({ data }),
    onSuccess: () => invalidateLocationQueries(queryClient),
  });
}

/**
 * Hook to update a library location
 */
export function useUpdateLibraryLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      locationId: string;
      name?: string;
      description?: string;
      referenceImageUrl?: string;
    }) => updateLibraryLocationFn({ data }),
    onSuccess: (_, variables) =>
      invalidateLocationQueries(queryClient, variables.locationId),
  });
}

/**
 * Hook to delete a library location
 */
export function useDeleteLibraryLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (locationId: string) =>
      deleteLibraryLocationFn({ data: { locationId } }),
    onSuccess: () => invalidateLocationQueries(queryClient),
  });
}

/**
 * Hook to upload location media via presigned URL
 */
export function useUploadLocationMedia() {
  return useMutation({
    mutationFn: async (data: {
      file: File;
      locationId?: string;
      onProgress?: (percent: number) => void;
    }) => {
      // 1. Get presigned URL from server
      const presign = await presignLocationUploadFn({
        data: {
          filename: data.file.name,
          locationId: data.locationId,
        },
      });

      // 2. Upload directly to R2
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );

      // 3. Finalize: update DB record if uploading to an existing location
      if (data.locationId) {
        await finalizeLocationUploadFn({
          data: {
            locationId: data.locationId,
            publicUrl: presign.publicUrl,
            path: presign.path,
          },
        });
      }

      return { url: presign.publicUrl, path: presign.path };
    },
  });
}

/**
 * Hook to add reference images to an existing location
 */
export function useAddLocationSheets() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { locationId: string; imageUrls: string[] }) =>
      addLocationSheetsFn({ data }),
    onSuccess: (_, variables) =>
      invalidateLocationQueries(queryClient, variables.locationId),
  });
}

/**
 * Hook to delete a reference image from a location
 */
export function useDeleteLocationSheet() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { sheetId: string; locationId: string }) =>
      deleteLocationSheetFn({ data: { sheetId: data.sheetId } }),
    onSuccess: (_, variables) =>
      invalidateLocationQueries(queryClient, variables.locationId),
  });
}
