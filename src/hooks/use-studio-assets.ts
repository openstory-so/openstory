import { useAuthGate } from '@/components/auth/auth-gate-provider';
import {
  createStudioAssetsFn,
  deleteStudioAssetFn,
  draftStudioPromptFn,
  listStudioAssetsFn,
  setStudioAssetFavoriteFn,
} from '@/functions/studio-assets';
import type {
  StudioActivity,
  StudioCreateInput,
  StudioSort,
} from '@/lib/studio/schema';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
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

const PAGE_SIZE = 40;

export function useStudioAssets(filters: StudioAssetFilters) {
  const { isAuthenticated } = useAuthGate();

  return useInfiniteQuery({
    queryKey: studioAssetKeys.list(filters),
    enabled: isAuthenticated,
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

export function useCreateStudioAssets() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: StudioCreateInput) =>
      createStudioAssetsFn({ data: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: studioAssetKeys.all });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
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
      toast.error(error.message);
    },
  });
}
