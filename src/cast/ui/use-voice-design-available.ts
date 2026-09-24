import { getVoiceDesignAvailableFn } from '@/cast/voice.fn';
import { queryOptions, useQuery } from '@tanstack/react-query';

/** A platform-key fact, so one fetch per session. */
const voiceDesignQuery = queryOptions({
  queryKey: ['voice-design-available'],
  queryFn: () => getVoiceDesignAvailableFn(),
  staleTime: Infinity,
});

/**
 * Is Voice Design available on this deployment (#1553)? `undefined` while
 * unknown — callers must treat that as "don't touch the flag yet", never as
 * unavailable, or a remembered opt-in gets dropped and persisted as off
 * during the first paint.
 */
export function useVoiceDesignAvailable(): boolean | undefined {
  return useQuery(voiceDesignQuery).data?.available;
}

/** Are new voices Seed voices, whose takes are paid one by one (#1765)? */
export function useSeedVoices(): boolean {
  return useQuery(voiceDesignQuery).data?.seed ?? false;
}
