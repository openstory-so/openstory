import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { getAllAdminStudioAssetsFn } from '@/platform/admin-support.fn';
import {
  classifyStudioReferenceFn,
  createStudioAssetsFn,
  deleteStudioAssetFn,
  draftStudioPromptFn,
  listStudioAssetsFn,
  setStudioAssetFavoriteFn,
} from '@/studio/studio-assets.fn';
import {
  studioCreateInputSchema,
  type StudioActivity,
  type StudioCreateInput,
  type StudioSort,
} from '@/studio/schema';
import {
  useInfiniteQuery,
  useMutation,
  useMutationState,
  useQueries,
  useQueryClient,
} from '@tanstack/react-query';
import { isInsufficientCreditsError } from '@/platform/errors';
import { toast } from 'sonner';

type StudioAssetFilters = {
  activity?: StudioActivity;
  favoritesOnly?: boolean;
  order?: StudioSort;
};

const studioAssetKeys = {
  all: ['studio-assets'] as const,
  list: (filters: StudioAssetFilters) =>
    [...studioAssetKeys.all, 'list', filters] as const,
};

const adminStudioAssetKeys = {
  all: ['admin-support', 'studio-assets'] as const,
  list: (filters: StudioAssetFilters & { search?: string }) =>
    [...adminStudioAssetKeys.all, 'list', filters] as const,
};

const PAGE_SIZE = 40;

export function useStudioAssets(filters: StudioAssetFilters, enabled = true) {
  const { isAuthenticated } = useAuthGate();

  return useInfiniteQuery({
    queryKey: studioAssetKeys.list(filters),
    enabled: isAuthenticated && enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      listStudioAssetsFn({
        data: {
          activity: filters.activity,
          favoritesOnly: filters.favoritesOnly,
          order: filters.order,
          limit: PAGE_SIZE,
          cursor: pageParam,
        },
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages;
      if (!pages) return false;
      const inFlight = pages.some((page) =>
        page.assets.some(
          (asset) => asset.status === 'queued' || asset.status === 'running'
        )
      );
      return inFlight ? 2000 : false;
    },
  });
}

/** Cross-team studio gallery for support mode. Gated by the caller on isAdmin. */
export function useAdminStudioAssets(
  filters: StudioAssetFilters & { search?: string },
  enabled: boolean
) {
  const trimmedSearch = filters.search?.trim() || undefined;

  return useInfiniteQuery({
    queryKey: adminStudioAssetKeys.list({
      ...filters,
      search: trimmedSearch,
    }),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      getAllAdminStudioAssetsFn({
        data: {
          activity: filters.activity,
          favoritesOnly: filters.favoritesOnly,
          order: filters.order,
          search: trimmedSearch,
          limit: PAGE_SIZE,
          cursor: pageParam,
        },
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 60_000,
  });
}

// Module-level so pending creates can be found by identity (no `mutationKey`:
// a keyed mutation would stop the global cache from refreshing the balance).
const createStudioAssets = (input: StudioCreateInput) =>
  createStudioAssetsFn({ data: input });

export function useCreateStudioAssets() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createStudioAssets,
    // Awaited so the mutation stays pending until the new rows are in the
    // list — the composer's spinner and the gallery's placeholder tiles
    // (#1455) hand off to the real queued tiles with no gap.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: studioAssetKeys.all }),
        // The gate just recorded the sign-offs; re-ask so the blocks drop.
        queryClient.invalidateQueries({ queryKey: referenceRightsKeys.all }),
      ]),
    onError: (error) => {
      if (isInsufficientCreditsError(error)) return;
      toast.error(error.message);
    },
  });
}

const referenceRightsKeys = {
  all: ['studio-reference-rights'] as const,
  url: (url: string) => [...referenceRightsKeys.all, url] as const,
};

/**
 * Rights check per gated reference image (#1581): whether this team has
 * already attested to it, and whether it shows a real person. Results are
 * one per `urls` entry, in order. Cached for the session — a still that was
 * classified once is not billed again when re-attached.
 */
export function useStudioReferenceRights(urls: string[]) {
  const { isAuthenticated } = useAuthGate();
  return useQueries({
    queries: urls.map((url) => ({
      queryKey: referenceRightsKeys.url(url),
      queryFn: () => classifyStudioReferenceFn({ data: { url } }),
      enabled: isAuthenticated,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    })),
  });
}

/** Inputs of studio generations still being started, newest first (#1455). */
export function useStudioPendingCreates(activity: StudioActivity) {
  return useMutationState({
    filters: {
      status: 'pending',
      predicate: (mutation) =>
        mutation.options.mutationFn === createStudioAssets,
    },
    select: (mutation) =>
      studioCreateInputSchema.parse(mutation.state.variables),
  })
    .filter((input) => input.activity === activity)
    .reverse();
}

export function useToggleStudioFavorite() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; isFavorite: boolean }) =>
      setStudioAssetFavoriteFn({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studioAssetKeys.all });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}

export function useDeleteStudioAsset() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteStudioAssetFn({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studioAssetKeys.all });
      toast.success('Deleted');
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
}

export function useDraftStudioPrompt() {
  return useMutation({
    mutationFn: (input: Parameters<typeof draftStudioPromptFn>[0]['data']) =>
      draftStudioPromptFn({ data: input }),
    onError: (error) => {
      if (isInsufficientCreditsError(error)) return;
      toast.error(error.message);
    },
  });
}
