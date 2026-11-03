import { AskAssistantButton } from '@/assistant/ui/ask-assistant-button';
import { LibraryVirtualGrid } from '@/cast/ui/library-virtual-grid';
import { OrganizationLocationCard } from '@/cast/ui/location-library/organization-location-card';
import {
  useOrganizationLocationDivergentVariants,
  useOrganizationLocations,
} from '@/cast/ui/use-organization-locations';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { MapPin } from 'lucide-react';
import type React from 'react';

/**
 * The team's locations as a grid (#1695), most recently used first. Every
 * sequence's one-off locations are here too, so the rows are virtualized
 * against the page's scroller.
 */
export const OrganizationLocationList: React.FC<{
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The page's `?search=`: matched against name and description. */
  search: string;
}> = ({ scrollRef, search }) => {
  const { data: all } = useOrganizationLocations();
  const q = search.trim().toLowerCase();
  const locations = q
    ? all.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          l.description?.toLowerCase().includes(q)
      )
    : all;
  const { data: divergent } = useOrganizationLocationDivergentVariants();

  if (locations.length === 0) {
    return (
      <EmptyState
        icon={<MapPin className="h-12 w-12" />}
        title={q ? 'No location matches' : 'No locations yet'}
        description={
          q
            ? 'Try another search.'
            : 'Make one with New location, or analyse a sequence.'
        }
        action={q ? undefined : <AskAssistantButton context={[]} />}
      />
    );
  }

  return (
    <LibraryVirtualGrid
      items={locations}
      scrollRef={scrollRef}
      estimateRowHeight={280}
      renderItem={(location) => (
        <OrganizationLocationCard
          location={location}
          divergentVariantId={
            divergent?.find((v) => v.locationId === location.id)?.id
          }
        />
      )}
    />
  );
};
