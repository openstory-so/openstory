import { isBytePlusConfigured } from '@/lib/ai/byteplus-config';
import { createServerFn } from '@tanstack/react-start';

/**
 * Whether the platform can claim the BytePlus via (#1157). `ARK_API_KEY` is
 * server-only, but the client needs its PRESENCE for two things that would
 * otherwise silently show the wrong via's numbers: the scene editor's
 * optimised-prompt preview (which request the model actually receives) and
 * ActionCost labels (which rate card the price comes from). The boolean leaks
 * nothing — it says a key exists, not what it is.
 */
export const getMediaRoutesFn = createServerFn({ method: 'GET' }).handler(
  () => ({
    byteplusEnabled: isBytePlusConfigured(),
  })
);
