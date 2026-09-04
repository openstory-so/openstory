/**
 * Which native media vias this team reaches, and the video models that follow
 * from it (today: which ones can render reference-only shots).
 *
 * Warmed by the `_app` route's `beforeLoad` via `ensureQueryData`, so the
 * model selectors render the right list on first paint instead of filtering a
 * short-lived default and then re-filtering — the same seed-the-query pattern
 * the session uses one line above it.
 *
 * The fallback is deliberately the CONSERVATIVE answer (no native vias, fal
 * reference-to-video models only): it is what an anonymous visitor gets, and
 * it can only ever under-offer. Over-offering would put a model in the picker
 * that the create handler then rejects.
 */

import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  getViaAvailabilityFn,
  type ViaAvailability,
} from '@/functions/via-availability';
import { referenceOnlyMotionModels } from '@/lib/ai/models';

/** No native vias — every model that qualifies on its fal route alone. */
const CONSERVATIVE: ViaAvailability = {
  xai: false,
  byteplus: false,
  referenceOnlyModels: referenceOnlyMotionModels(),
};

export const viaAvailabilityQueryOptions = queryOptions({
  queryKey: ['via-availability'] as const,
  queryFn: () => getViaAvailabilityFn(),
  // Keyed off platform env + the team's BYOK rows; neither moves often, and a
  // stale `true` is corrected by the server at submit time.
  staleTime: 5 * 60 * 1000,
});

export function useViaAvailability(): ViaAvailability {
  const { data } = useQuery({
    ...viaAvailabilityQueryOptions,
    // Anonymous visitors 401 here (the fn needs a team). Browsing the composer
    // signed-out is supported, so failing back to the conservative list is the
    // designed outcome, not an error to surface.
    retry: false,
  });
  return data ?? CONSERVATIVE;
}
