import { BackButton } from '@/components/layout/back-button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceLocationDivergentVariants } from '@/hooks/use-location-sheet-variants';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import { Link } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';
import { useMemo } from 'react';
import { LocationCard } from './location-card';

type LocationViewProps = {
  sequenceId: string;
};

export const LocationView: React.FC<LocationViewProps> = ({ sequenceId }) => {
  const {
    data: locations,
    isLoading,
    error,
  } = useSequenceLocations(sequenceId);
  const { data: divergentVariants } =
    useSequenceLocationDivergentVariants(sequenceId);
  const divergentByLocationId = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of divergentVariants ?? []) {
      if (!map.has(v.parentId)) map.set(v.parentId, v.id);
    }
    return map;
  }, [divergentVariants]);

  const header = (
    <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
      <BackButton
        fallbackTo="/sequences/$id/scenes"
        sequenceId={sequenceId}
        label="Back to scenes"
      />
      <h1 className="text-lg font-semibold">Locations</h1>
    </div>
  );

  if (error) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-destructive">Failed to load locations</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {error.message}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="aspect-video w-full rounded-lg" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : !locations || locations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-full bg-muted p-6">
              <MapPin className="h-12 w-12 text-muted-foreground/50" />
            </div>
            <div>
              <h3 className="text-lg font-medium">No locations found</h3>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Locations will appear here once your script has been analyzed.
                Add a script to your sequence to get started.
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {locations.map((location) => (
              <Link
                key={location.id}
                to="/sequences/$id/locations/$locationId"
                params={{ id: sequenceId, locationId: location.id }}
                className="block"
              >
                <LocationCard
                  location={location}
                  divergentVariantId={divergentByLocationId.get(location.id)}
                />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
