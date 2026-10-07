import { TeamCharacterList } from '@/cast/ui/character-library/team-character-list';
import { AddTalentDialog } from '@/cast/ui/talent-library/add-talent-dialog';
import { LibraryFilters } from '@/cast/ui/talent-library/talent-library-filters';
import { LibraryGridSkeleton } from '@/cast/ui/talent-library/talent-library-list';
import { TalentLibraryTab } from '@/cast/ui/talent-library/talent-library-tab';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { PageContainer } from '@/ui/layout/page-container';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs';
import { PageIntro } from '@/ui/typography/page-intro';
import { createFileRoute } from '@tanstack/react-router';
import { User } from 'lucide-react';
import { Suspense, useRef } from 'react';
import { z } from 'zod';

// No `.default()`: a default makes the router rewrite bare /characters with
// a 307, which turns the sitemap entry into a redirect (#814). The fallbacks
// live in the component.
const searchParamsSchema = z.object({
  tab: z.enum(['characters', 'talent']).optional(),
  /** Characters tab: every character, or the library only. */
  show: z.enum(['all', 'library']).optional(),
  /** Talent tab. */
  filter: z.enum(['all', 'favorites']).optional(),
});

const CHARACTER_FILTERS = [
  { value: 'all', label: 'All Characters' },
  { value: 'library', label: 'Library' },
] as const;

export const Route = createFileRoute('/_app/characters/')({
  validateSearch: searchParamsSchema,
  component: CharactersPage,
  staticData: { breadcrumb: 'Characters' },
});

function CharactersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: session, isPending } = useAuthSession();
  const isAuthenticated = !!session;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Signed out, the page is the public talent catalogue.
  const tab = search.tab ?? (isAuthenticated ? 'characters' : 'talent');
  const show = search.show ?? 'all';

  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      {tab === 'talent' ? (
        <PageIntro title="Talent Library" actions={<AddTalentDialog />}>
          {isAuthenticated
            ? "Manage your team's talent library for consistent AI-generated content."
            : 'Browse system talent. Sign in to add your own and keep characters consistent across sequences.'}
        </PageIntro>
      ) : (
        <PageIntro title="Characters">
          Your team's characters. One in the library can be cast in any
          sequence.
        </PageIntro>
      )}
      <PageContainer padding="none" className="pb-8">
        {isPending && search.tab === undefined ? (
          <LibraryGridSkeleton />
        ) : (
          <Tabs
            value={tab}
            onValueChange={(next) =>
              void navigate({
                search: { tab: next === 'talent' ? 'talent' : 'characters' },
              })
            }
            className="gap-6"
          >
            <TabsList>
              <TabsTrigger value="characters">Characters</TabsTrigger>
              <TabsTrigger value="talent">Talent</TabsTrigger>
            </TabsList>
            <TabsContent value="characters" className="flex flex-col gap-6">
              {isAuthenticated ? (
                <>
                  <LibraryFilters
                    current={show}
                    filters={CHARACTER_FILTERS}
                    onSelect={(next) =>
                      void navigate({
                        search: { tab: 'characters', show: next },
                      })
                    }
                  />
                  <Suspense fallback={<LibraryGridSkeleton />}>
                    <TeamCharacterList
                      inLibrary={show === 'library'}
                      scrollRef={scrollRef}
                    />
                  </Suspense>
                </>
              ) : isPending ? (
                <LibraryGridSkeleton />
              ) : (
                <EmptyState
                  icon={<User className="h-12 w-12" />}
                  title="Sign in to see your characters"
                  description="Characters belong to your team."
                  action={<SignInButton />}
                />
              )}
            </TabsContent>
            <TabsContent value="talent">
              <TalentLibraryTab
                filter={search.filter ?? 'all'}
                onFilterChange={(filter) =>
                  void navigate({ search: { tab: 'talent', filter } })
                }
              />
            </TabsContent>
          </Tabs>
        )}
      </PageContainer>
    </div>
  );
}
