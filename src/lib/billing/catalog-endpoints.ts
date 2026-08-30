/**
 * Endpoint IDs for models we expose in the product catalog.
 * Used to ship a small pricing map to the client for ActionCost labels (#1140)
 * instead of the full ~1,350-row fal catalog.
 */

import { getFalEndpointIds } from '@/lib/ai/fal-endpoints';
import { IMAGE_MODELS, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';

/**
 * Unique pricing ids for every endpoint a client-side estimate can price:
 * image / video / audio models, edit + motion-reference siblings, and the
 * studio text-to-video / reference-to-video endpoints (#1388 — those were
 * missing, so the studio cost label logged "No fal pricing data").
 *
 * BytePlus ids ride along unconditionally (#1157) rather than gated on
 * `ARK_API_KEY`: this map is cached by the client, the route can flip when a
 * key is added, and a missing row makes ActionCost render nothing at all.
 * The extra rows are a handful of entries off a static card.
 */
export function catalogFalEndpointIds(): string[] {
  const ids = new Set(getFalEndpointIds());
  for (const model of [
    ...Object.values(IMAGE_MODELS),
    ...Object.values(IMAGE_TO_VIDEO_MODELS),
  ]) {
    if ('byteplusId' in model) ids.add(model.byteplusId);
  }
  return [...ids];
}
