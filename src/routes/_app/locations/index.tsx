import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { AddLocationDialog } from '@/components/location-library/add-location-dialog';
import { LocationLibraryFilters } from '@/components/location-library/location-library-filters';
import { LocationLibraryList } from '@/components/location-library/location-library-list';
import { PageContainer } from '@/components/layout/page-container';
import { PageIntro } from '@/components/typography/page-intro';
import { EmptyState } from '@/components/ui/empty-state';
import { useLibraryLocations } from '@/hooks/use-sequence-locations';
import { createFileRoute } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';
import { z } from 'zod';

const searchParamsSchema = z.object({
  search: z.string().optional(),
});

export const Route = createFileRoute('/_app/locations/')({
  validateSearch: searchParamsSchema,
  component: LocationsPage,
  staticData: { breadcrumb: 'Locations' },
});

function LocationsPage() {
  const { search } = Route.useSearch();
  const { isAuthenticated } = useAuthGate();
  const { data: locations, isLoading, error } = useLibraryLocations();

  // Filter locations based on search params
  const filteredLocations = locations?.filter((loc) => {
    // Filter by search query
    if (search) {
      const query = search.toLowerCase();
      return (
        loc.name.toLowerCase().includes(query) ||
        loc.description?.toLowerCase().includes(query)
      );
    }

    return true;
  });

  // Anonymous visitors browse the public ("system") location catalogue and
  // can open the dialog; the actual add prompts a login (gated inside
  // AddLocationDialog).
  const addAction = <AddLocationDialog />;

  return (
    <div className="h-full overflow-auto">
      <PageIntro title="Location Library" actions={addAction}>
        {isAuthenticated
          ? 'Browse and manage location references across all your sequences. Upload custom references to maintain visual consistency.'
          : 'Browse system locations. Sign in to add your own references and keep settings consistent across sequences.'}
      </PageIntro>
      <PageContainer padding="none" className="pb-8">
        {isAuthenticated && <LocationLibraryFilters currentSearch={search} />}

        {!isLoading && filteredLocations && filteredLocations.length === 0 ? (
          <EmptyState
            icon={<MapPin className="h-12 w-12" />}
            title={
              isAuthenticated ? 'No locations yet' : 'No system locations yet'
            }
            description={
              isAuthenticated
                ? 'Add locations to your library to maintain visual consistency across your sequences.'
                : 'Check back soon, or sign in to build your own location library.'
            }
            action={addAction}
          />
        ) : (
          <LocationLibraryList
            locations={filteredLocations}
            isLoading={isLoading}
            error={error}
          />
        )}
      </PageContainer>
    </div>
  );
}
