/**
 * Query keys for locations (#1695). A location is the team's, so one edit
 * can move the team list, every sequence's list and the sheet lists:
 * `invalidateLocations` refetches them all.
 */
import type { QueryClient } from '@tanstack/react-query';
import { shotStalenessNamespace } from '@/shots/ui/use-shot-staleness';

/** A read made from no sequence (the Locations page) is keyed `team`. */
const scope = (sequenceId: string | null) => sequenceId ?? 'team';

export const sequenceLocationKeys = {
  all: ['sequence-locations'] as const,
  list: (sequenceId: string) =>
    [...sequenceLocationKeys.all, 'list', sequenceId] as const,
  detail: (sequenceId: string | null, locationDbId: string) =>
    [
      ...sequenceLocationKeys.all,
      'detail',
      scope(sequenceId),
      locationDbId,
    ] as const,
  shotsForLocation: (sequenceId: string, locationId: string) =>
    [...sequenceLocationKeys.all, 'shots', sequenceId, locationId] as const,
  sheetStaleness: (sequenceId: string | null, locationDbId: string) =>
    [
      ...sequenceLocationKeys.all,
      'sheet-staleness',
      scope(sequenceId),
      locationDbId,
    ] as const,
};

export const teamLocationKeys = {
  all: ['team-locations'] as const,
  list: () => [...teamLocationKeys.all, 'list'] as const,
  detail: (id: string) => [...teamLocationKeys.all, 'detail', id] as const,
};

export const locationSheetVariantKeys = {
  all: ['location-sheet-variants'] as const,
  /** Every divergent-alternate list: one location's and the team's. */
  divergent: () => [...locationSheetVariantKeys.all, 'divergent'] as const,
  divergentByLocation: (sequenceId: string | null, locationDbId: string) =>
    [
      ...locationSheetVariantKeys.divergent(),
      scope(sequenceId),
      locationDbId,
    ] as const,
  divergentByTeam: () =>
    [...locationSheetVariantKeys.divergent(), 'team'] as const,
  history: (sequenceId: string | null, locationDbId: string) =>
    [
      ...locationSheetVariantKeys.all,
      'history',
      scope(sequenceId),
      locationDbId,
    ] as const,
};

/**
 * Refetch everything a location write can move: the team list, every
 * sequence's locations, the sheet versions and the staleness dots. Returns
 * the sequence refetch so a caller can stay pending until it lands.
 */
export function invalidateLocations(queryClient: QueryClient): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: teamLocationKeys.all });
  void queryClient.invalidateQueries({
    queryKey: locationSheetVariantKeys.all,
  });
  void queryClient.invalidateQueries({ queryKey: shotStalenessNamespace });
  return queryClient.invalidateQueries({ queryKey: sequenceLocationKeys.all });
}
