import { getVoiceDesignAvailableFn } from '@/cast/voice.fn';
import { useQuery } from '@tanstack/react-query';

/**
 * Is Voice Design available on this deployment (#1553)? A platform-key fact,
 * so one fetch per session. `undefined` while unknown — callers must treat
 * that as "don't touch the flag yet", never as unavailable, or a remembered
 * opt-in gets dropped and persisted as off during the first paint.
 */
export function useVoiceDesignAvailable(): boolean | undefined {
  const { data } = useQuery({
    queryKey: ['voice-design-available'],
    queryFn: () => getVoiceDesignAvailableFn(),
    staleTime: Infinity,
  });
  return data?.available;
}

/** Are new voices Seed voices, whose takes are paid one by one (#1765)? */
export function useSeedVoices(): boolean {
  const { data } = useQuery({
    queryKey: ['voice-design-available'],
    queryFn: () => getVoiceDesignAvailableFn(),
    staleTime: Infinity,
  });
  return data?.seed ?? false;
}
