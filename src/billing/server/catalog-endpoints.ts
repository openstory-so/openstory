/**
 * Endpoint IDs for models we expose in the product catalog.
 * Used to ship a small pricing map to the client for ActionCost labels (#1140)
 * instead of the full ~1,350-row fal catalog.
 */

import { ELEVENLABS_MUSIC_ENDPOINT } from '@/billing/elevenlabs-pricing';
import { getFalEndpointIds } from '@/models/fal-endpoints';
import { IMAGE_MODELS, IMAGE_TO_VIDEO_MODELS } from '@/models/models';

/**
 * Unique pricing ids for every endpoint a client-side estimate can price:
 * image / video / audio models, edit + motion-reference siblings, and the
 * studio text-to-video / reference-to-video endpoints (#1388 — those were
 * missing, so the studio cost label logged "No fal pricing data").
 *
 * BytePlus ids ride along unconditionally (#1157) rather than gated on
 * `ARK_API_KEY`: this map is cached by the client, the route can flip when a
 * key is added, and a missing row makes ActionCost render nothing at all.
 * Native ElevenLabs music is the same shape (#1640): the catalog id is not a
 * fal endpoint, so `getFalEndpointIds` omits it and we add it here. The extra
 * rows are a handful of entries off a static card.
 */
export function catalogFalEndpointIds(): string[] {
  const ids = new Set(getFalEndpointIds());
  for (const model of [
    ...Object.values(IMAGE_MODELS),
    ...Object.values(IMAGE_TO_VIDEO_MODELS),
  ]) {
    if ('byteplusId' in model) ids.add(model.byteplusId);
  }
  ids.add(ELEVENLABS_MUSIC_ENDPOINT);
  return [...ids];
}
