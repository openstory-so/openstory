import { getElevenLabsVoiceFn, listElevenLabsVoicesFn } from '@/cast/voice.fn';
import type { CatalogVoiceSource, SavedVoiceMeta } from '@/cast/voice';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

export const elevenLabsVoiceKeys = {
  all: ['elevenlabs-voices'] as const,
  list: (source: CatalogVoiceSource, search: string) =>
    [...elevenLabsVoiceKeys.all, 'list', source, search] as const,
  saved: (characterId: string, voiceId = '') =>
    [...elevenLabsVoiceKeys.all, 'saved', characterId, voiceId] as const,
};

export function useElevenLabsVoices(
  source: CatalogVoiceSource,
  search: string,
  enabled: boolean
) {
  return useInfiniteQuery({
    queryKey: elevenLabsVoiceKeys.list(source, search),
    queryFn: ({ pageParam }) =>
      listElevenLabsVoicesFn({
        data: {
          source,
          ...(search ? { search } : {}),
          ...(source === 'library' ? { page: pageParam } : {}),
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
    queryFn: () => getElevenLabsVoiceFn({ data: { voiceId: voiceId ?? '' } }),
    enabled: enabled && Boolean(voiceId),
    staleTime: 5 * 60 * 1000,
  });
}
