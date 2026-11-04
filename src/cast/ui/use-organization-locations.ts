/**
 * The organization's locations (#1695): the Locations page list, one location with
 * the sequences that use it and its photos, its delete, and the writes made
 * with no sequence.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  createOrganizationLocationFn,
  deleteOrganizationLocationFn,
  finalizeLocationUploadFn,
  getOrganizationLocationDivergentVariantsFn,
  getOrganizationLocationFn,
  listOrganizationLocationsFn,
  presignLocationUploadFn,
  removeOrganizationLocationPhotoFn,
  restoreOrganizationLocationFn,
  updateOrganizationLocationFn,
} from '@/cast/organization-locations.fn';
import {
  invalidateLocations,
  locationSheetVariantKeys,
  organizationLocationKeys,
} from '@/cast/ui/location-keys';
import { useUploadRightsGate } from '@/cast/ui/upload-rights-gate';
import type { LocationBibleInput } from '@/cast/ui/use-sequence-locations';
import { putToR2, snapshotFile } from '@/ui/upload';

export { organizationLocationKeys };

/** The organization's locations, most recently used first. Signed-in only. */
export function useOrganizationLocations() {
  return useSuspenseQuery({
    queryKey: organizationLocationKeys.list(),
    queryFn: () => listOrganizationLocationsFn(),
    staleTime: 30_000,
    // A sheet being drawn reports on its own channel, which the list does
    // not open: poll until none is.
    refetchInterval: (query) =>
      query.state.data?.some((l) => l.referenceStatus === 'generating')
        ? 5_000
        : false,
  });
}

/**
 * The same list for a picker or the `@` dropdown: never suspends, and asks
 * nothing while closed or signed out.
 */
export function useOrganizationLocationList(enabled: boolean) {
  return useQuery({
    queryKey: organizationLocationKeys.list(),
    queryFn: () => listOrganizationLocationsFn(),
    staleTime: 30_000,
    enabled,
  });
}

export function useOrganizationLocation(locationId: string) {
  return useSuspenseQuery({
    queryKey: organizationLocationKeys.detail(locationId),
    queryFn: () => getOrganizationLocationFn({ data: { locationId } }),
    staleTime: 30_000,
  });
}

/** The location's name for a breadcrumb: never suspends the header. */
export function useOrganizationLocationName(locationId: string) {
  return useQuery({
    queryKey: organizationLocationKeys.detail(locationId),
    queryFn: () => getOrganizationLocationFn({ data: { locationId } }),
    staleTime: 30_000,
    select: (location) => location?.name,
  });
}

/** The photos a location's sheet is drawn from. */
export function useLocationPhotos(locationId: string) {
  return useQuery({
    queryKey: organizationLocationKeys.detail(locationId),
    queryFn: () => getOrganizationLocationFn({ data: { locationId } }),
    staleTime: 30_000,
    select: (location) => location?.photos,
  });
}

/** Live divergent sheet alternates across the organization's locations: the card dots. */
export function useOrganizationLocationDivergentVariants() {
  return useQuery({
    queryKey: locationSheetVariantKeys.divergentByOrganization(),
    queryFn: () => getOrganizationLocationDivergentVariantsFn(),
    staleTime: 30_000,
  });
}

/** Make a location with no sequence and start its sheet. The caller shows the failure. */
export function useCreateOrganizationLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      rendering: string;
      photoUrls: string[];
    }) => createOrganizationLocationFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/** Edit the bible from no sequence. The form shows the failure. */
export function useUpdateOrganizationLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: { locationId: string; name?: string } & LocationBibleInput
    ) => updateOrganizationLocationFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/** Delete a location no sequence uses. Its own page shows the failure. */
export function useDeleteOrganizationLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { locationId: string }) =>
      deleteOrganizationLocationFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/** Undo a delete, from its toast. */
export function useRestoreOrganizationLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { globalError: true },
    mutationFn: (data: { locationId: string }) =>
      restoreOrganizationLocationFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/**
 * Upload photos of a place: presign, R2 (`uploads/`), then the likeness
 * check (a real person opens the sign-off dialog). Hands back the stored
 * URLs, cleared or signed, in the order given.
 */
function useUploadPhotos() {
  const { ensureUploadRights } = useUploadRightsGate();
  return async (
    files: readonly File[],
    onProgress?: (file: File, percent: number) => void
  ): Promise<string[]> => {
    const uploaded = await Promise.all(
      files.map(async (original) => {
        const file = await snapshotFile(original);
        const presign = await presignLocationUploadFn({
          data: { filename: file.name },
        });
        await putToR2(presign.uploadUrl, file, presign.contentType, (percent) =>
          onProgress?.(original, percent)
        );
        return { url: presign.publicUrl, filename: original.name };
      })
    );
    await ensureUploadRights(uploaded);
    return uploaded.map((photo) => photo.url);
  };
}

/** Upload one photo for a location not made yet. The dropzone shows the failure. */
export function useUploadLocationPhoto() {
  const upload = useUploadPhotos();
  return useMutation({
    mutationFn: async (data: {
      file: File;
      onProgress?: (percent: number) => void;
    }) => {
      const [url] = await upload([data.file], (_file, percent) =>
        data.onProgress?.(percent)
      );
      if (!url) throw new Error('Upload failed');
      return url;
    },
  });
}

/**
 * Add photos to a location. Nothing is drawn: the sheet reads stale until it
 * is regenerated. The caller shows the failure.
 */
export function useAddLocationPhotos() {
  const queryClient = useQueryClient();
  const upload = useUploadPhotos();
  return useMutation({
    mutationFn: async (data: {
      locationId: string;
      files: readonly File[];
    }) => {
      const urls = await upload(data.files);
      // One at a time: the photos keep the order they were picked in.
      for (const publicUrl of urls) {
        await finalizeLocationUploadFn({
          data: { locationId: data.locationId, publicUrl },
        });
      }
    },
    // Some photos may have landed before a failure.
    onSettled: () => {
      void invalidateLocations(queryClient);
    },
  });
}

/** Remove one photo. The sheet reads stale; nothing is drawn. */
export function useRemoveLocationPhoto() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { locationId: string; photoId: string }) =>
      removeOrganizationLocationPhotoFn({ data }),
    onSuccess: () => {
      void invalidateLocations(queryClient);
    },
  });
}
