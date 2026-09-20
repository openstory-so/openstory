/**
 * Selection-scoped facet resolution.
 *
 * Which cast, locations and elements belong to a shot is decided by matching
 * the shot's continuity tags (and, for elements, its prompts) against the
 * sequence bible. That resolution is server-owned: it is the SAME
 * question the image-generation path answers when it picks reference images
 * (`shot-image.ts`), so resolving it here keeps the inspector showing exactly
 * what a render would use.
 *
 * The inspector previously fetched the whole bible and re-derived the matches
 * in the browser, with a hand-copied matcher that only checked the environment
 * tag — never the scene location. Generation checks both, so shots rendered
 * WITH a location reference showed "No locations in this selection".
 *
 * Returned as maps keyed by shot id rather than per-selection lists so the
 * client caches one result per sequence and does an O(1) lookup as the
 * selection changes, instead of a round trip per click.
 */

import { sequenceAccessMiddleware } from '@/platform/middleware.fn';
import { loadSceneFacets } from '@/shots/server/scene-facets';
import { createServerFn } from '@tanstack/react-start';

/** Facet ids that apply to each shot, keyed by shot id. */
export type SceneFacetMaps = {
  locationIdsByShot: Record<string, string[]>;
  characterIdsByShot: Record<string, string[]>;
  elementIdsByShot: Record<string, string[]>;
};

export const getSceneFacetMapsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }): Promise<SceneFacetMaps> => {
    const { locationIdsByShot, characterIdsByShot, elementIdsByShot } =
      await loadSceneFacets(context.scopedDb, context.sequence);
    return { locationIdsByShot, characterIdsByShot, elementIdsByShot };
  });
