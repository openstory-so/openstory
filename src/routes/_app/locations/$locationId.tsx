import { DeleteLocationButton } from '@/cast/ui/location-library/delete-location-button';
import { LocationDetailView } from '@/cast/ui/locations/location-detail-view';
import {
  useTeamLocation,
  useTeamLocationName,
} from '@/cast/ui/use-team-locations';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { routeParams } from '@/ui/layout/breadcrumbs';
import { Button } from '@/ui/shadcn/button';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, MapPin } from 'lucide-react';
import { AskAssistantButton } from '@/assistant/ui/ask-assistant-button';
import { Suspense } from 'react';
import { z } from 'zod';

function LocationCrumbLabel({ id }: { id: string }) {
  const { data: name } = useTeamLocationName(id);
  return <>{name ?? '…'}</>;
}

export const Route = createFileRoute('/_app/locations/$locationId')({
  // The sequence whose use of the location the page shows.
  validateSearch: z.object({ sequence: z.string().min(1).optional() }),
  component: TeamLocationPage,
  staticData: {
    breadcrumb: (match) => {
      const { locationId } = routeParams<{ locationId: string }>(match);
      return [
        { label: 'Locations', to: '/locations' },
        { label: <LocationCrumbLabel id={locationId} /> },
      ];
    },
  },
});

function TeamLocationContent({ id }: { id: string }) {
  const { sequence: pickedSequenceId } = Route.useSearch();
  const { data: location } = useTeamLocation(id);
  // Gone or another team's. Reached from a stale link.
  if (!location) {
    return (
      <EmptyState
        icon={<MapPin className="h-12 w-12" />}
        title="Location not found"
        description="It was deleted, or it belongs to another team."
        action={
          <Button variant="outline" asChild>
            <Link to="/locations">Back to Locations</Link>
          </Button>
        }
      />
    );
  }
  const { sequences } = location;
  // From no sequence unless the URL names one: the location's own bible,
  // sheet and photos are the same either way.
  const shown = pickedSequenceId
    ? sequences.find((sequence) => sequence.id === pickedSequenceId)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="icon" asChild>
            <Link to="/locations" aria-label="Back to Locations">
              <ArrowLeft />
            </Link>
          </Button>
          <h1 className="text-lg font-semibold">{location.name}</h1>
          <AskAssistantButton
            context={[
              { kind: 'location', id: location.id, label: location.name },
            ]}
            prompt="How can I make this location feel more alive?"
          />
          {!location.usedAnywhere && (
            <DeleteLocationButton
              locationId={location.id}
              name={location.name}
            />
          )}
        </div>
        {sequences.length > 0 && (
          <nav
            aria-label="Sequences that use this location"
            className="flex flex-col gap-2"
          >
            <p className="text-sm text-muted-foreground">
              Used in {sequences.length}{' '}
              {sequences.length === 1 ? 'sequence' : 'sequences'}. Edits change
              this location in every sequence.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {sequences.map((sequence) => (
                <Button
                  key={sequence.id}
                  variant={sequence.id === shown?.id ? 'default' : 'outline'}
                  size="sm"
                  asChild
                >
                  <Link
                    to="/locations/$locationId"
                    params={{ locationId: id }}
                    search={{ sequence: sequence.id }}
                    aria-current={
                      sequence.id === shown?.id ? 'page' : undefined
                    }
                  >
                    {sequence.title}
                  </Link>
                </Button>
              ))}
              {shown && (
                <Button variant="link" size="sm" asChild>
                  <Link
                    to="/sequences/$id/locations/$locationId"
                    params={{ id: shown.id, locationId: id }}
                  >
                    Open in {shown.title}
                  </Link>
                </Button>
              )}
            </div>
          </nav>
        )}
      </div>

      {pickedSequenceId && !shown ? (
        <p className="p-4 text-sm font-medium">
          Not used in that sequence. Pick one above.
        </p>
      ) : (
        <div className="min-h-0 flex-1">
          <LocationDetailView
            key={shown?.id ?? 'team'}
            sequenceId={shown?.id ?? null}
            locationId={id}
            header="none"
          />
        </div>
      )}
    </div>
  );
}

function TeamLocationPage() {
  const { locationId } = Route.useParams();
  const { data: session, isPending } = useAuthSession();

  if (!isPending && !session) {
    return (
      <EmptyState
        icon={<MapPin className="h-12 w-12" />}
        title="Sign in to see this location"
        description="Locations belong to your team."
        action={<SignInButton />}
      />
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="aspect-video w-full rounded-lg" />
        </div>
      }
    >
      {!isPending && <TeamLocationContent key={locationId} id={locationId} />}
    </Suspense>
  );
}
