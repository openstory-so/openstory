import { routeParams } from '@/ui/layout/breadcrumbs';
import { LocationDetailView } from '@/cast/ui/locations/location-detail-view';
import { useSequenceLocations } from '@/cast/ui/use-sequence-locations';
import { createFileRoute } from '@tanstack/react-router';

function LocationCrumbLabel({
  sequenceId,
  locationId,
}: {
  sequenceId: string;
  locationId: string;
}) {
  const { data: locations } = useSequenceLocations(sequenceId);
  const location = locations?.find((l) => l.id === locationId);
  return <>{location?.name ?? '…'}</>;
}

export const Route = createFileRoute(
  '/_app/sequences/$id/_workspace/locations/$locationId'
)({
  component: LocationDetailPage,
  staticData: {
    breadcrumb: (match) => {
      const { id, locationId } = routeParams<{
        id: string;
        locationId: string;
      }>(match);
      return {
        label: <LocationCrumbLabel sequenceId={id} locationId={locationId} />,
      };
    },
  },
});

function LocationDetailPage() {
  const { id: sequenceId, locationId } = Route.useParams();

  return (
    <LocationDetailView
      key={locationId}
      sequenceId={sequenceId}
      locationId={locationId}
    />
  );
}
