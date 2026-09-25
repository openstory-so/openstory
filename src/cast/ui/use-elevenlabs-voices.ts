import { getSavedVoiceFn, listElevenLabsVoicesFn } from '@/cast/voice.fn';
import type { CatalogVoiceFilters, SavedVoiceMeta } from '@/cast/voice';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

export const elevenLabsVoiceKeys = {
  all: ['elevenlabs-voices'] as const,
  list: (search: string, filters: CatalogVoiceFilters) =>
    [
      ...elevenLabsVoiceKeys.all,
      'list',
      search,
      filters.gender ?? '',
      filters.age ?? '',
      filters.quality ?? '',
      filters.language ?? '',
      filters.accent ?? '',
    ] as const,
  saved: (characterId: string, voiceId = '') =>
    [...elevenLabsVoiceKeys.all, 'saved', characterId, voiceId] as const,
};

export function useElevenLabsVoices(
  search: string,
  filters: CatalogVoiceFilters,
  enabled: boolean
) {
  return useInfiniteQuery({
    queryKey: elevenLabsVoiceKeys.list(search, filters),
    queryFn: ({ pageParam }) =>
      listElevenLabsVoicesFn({
        data: {
          ...(search ? { search } : {}),
          page: pageParam,
          ...(filters.gender ? { gender: filters.gender } : {}),
          ...(filters.age ? { age: filters.age } : {}),
          ...(filters.quality ? { quality: filters.quality } : {}),
          ...(filters.language ? { language: filters.language } : {}),
          ...(filters.accent ? { accent: filters.accent } : {}),
        },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextPage,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useSavedVoiceMeta(
  characterId: string,
  voiceId: string | null | undefined,
  enabled: boolean
) {
  return useQuery<SavedVoiceMeta | null>({
    queryKey: elevenLabsVoiceKeys.saved(characterId, voiceId ?? ''),
    queryFn: () => getSavedVoiceFn({ data: { voiceId: voiceId ?? '' } }),
    enabled: enabled && Boolean(voiceId),
    staleTime: 5 * 60 * 1000,
    // A gone id is a successful null, not a retryable fetch (#1709).
    retry: false,
  });
}
