/**
 * Server-resolved facet membership for the inspector.
 *
 * One query per sequence; the selection is applied client-side as a set lookup,
 * never as a re-derivation of the match. See `functions/scene-facets.ts`.
 */

import { getSceneFacetMapsFn } from '@/functions/scene-facets';
import { useQuery } from '@tanstack/react-query';

export const sceneFacetKeys = {
  all: ['scene-facets'] as const,
  maps: (sequenceId: string) =>
    [...sceneFacetKeys.all, 'maps', sequenceId] as const,
};

export function useSceneFacetMaps(sequenceId?: string) {
  return useQuery({
    queryKey: sceneFacetKeys.maps(sequenceId ?? ''),
    queryFn: () =>
      getSceneFacetMapsFn({ data: { sequenceId: sequenceId ?? '' } }),
    enabled: Boolean(sequenceId),
    staleTime: 30_000,
  });
}

/**
 * Ids that apply to the shots in scope. `shotIds === null` means whole sequence
 * — the caller shows the unfiltered library rather than an empty set.
 */
export function facetIdsForShots(
  map: Record<string, string[]> | undefined,
  shotIds: ReadonlyArray<string> | null
): Set<string> | null {
  if (shotIds === null) return null;
  const ids = new Set<string>();
  if (!map) return ids;
  for (const shotId of shotIds) {
    for (const id of map[shotId] ?? []) ids.add(id);
  }
  return ids;
}
