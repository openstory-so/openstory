import { NewLocationDialog } from '@/cast/ui/location-library/new-location-dialog';
import { TeamLocationList } from '@/cast/ui/location-library/team-location-list';
import { LibraryGridSkeleton } from '@/cast/ui/library-virtual-grid';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { PageContainer } from '@/ui/layout/page-container';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { PageIntro } from '@/ui/typography/page-intro';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Input } from '@/ui/shadcn/input';
import { MapPin } from 'lucide-react';
import { Suspense, useRef } from 'react';
import { z } from 'zod';

export const Route = createFileRoute('/_app/locations/')({
  validateSearch: z.object({ search: z.string().optional() }),
  component: LocationsPage,
  staticData: { breadcrumb: 'Locations' },
});

function LocationsPage() {
  const { data: session, isPending } = useAuthSession();
  const navigate = useNavigate();
  const { search } = Route.useSearch();
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      <PageIntro
        title="Locations"
        actions={
          session ? (
            <NewLocationDialog
              onCreated={(location) =>
                void navigate({
                  to: '/locations/$locationId',
                  params: { locationId: location.id },
                })
              }
            />
          ) : undefined
        }
      >
        Every location your team has. Use one in a script with @.
      </PageIntro>
      <PageContainer padding="none" className="pb-8">
        {session ? (
          <div className="flex flex-col gap-6">
            <Input
              type="search"
              aria-label="Search locations"
              placeholder="Search locations…"
              defaultValue={search ?? ''}
              className="max-w-md"
              // The URL holds the filter; the list is filtered as it is typed.
              onChange={(event) =>
                void navigate({
                  to: '/locations',
                  search: { search: event.target.value || undefined },
                  replace: true,
                })
              }
            />
            <Suspense fallback={<LibraryGridSkeleton />}>
              <TeamLocationList scrollRef={scrollRef} search={search ?? ''} />
            </Suspense>
          </div>
        ) : isPending ? (
          <LibraryGridSkeleton />
        ) : (
          <EmptyState
            icon={<MapPin className="h-12 w-12" />}
            title="Sign in to see your locations"
            description="Locations belong to your team."
            action={<SignInButton />}
          />
        )}
      </PageContainer>
    </div>
  );
}
