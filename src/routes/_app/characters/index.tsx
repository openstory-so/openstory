import { NewCharacterDialog } from '@/cast/ui/character-library/new-character-dialog';
import { TeamCharacterList } from '@/cast/ui/character-library/team-character-list';
import { AddTalentDialog } from '@/cast/ui/talent-library/add-talent-dialog';
import { LibraryGridSkeleton } from '@/cast/ui/talent-library/talent-library-list';
import { TalentLibraryTab } from '@/cast/ui/talent-library/talent-library-tab';
import { rememberLibrarySearch } from '@/cast/ui/library-search';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { PageContainer } from '@/ui/layout/page-container';
import { EmptyState } from '@/ui/shadcn/empty-state';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/ui/shadcn/input-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/shadcn/tabs';
import { PageIntro } from '@/ui/typography/page-intro';
import { createFileRoute } from '@tanstack/react-router';
import { Search, User } from 'lucide-react';
import { Suspense, useRef } from 'react';
import { z } from 'zod';

// No `.default()`: a default makes the router rewrite bare /characters with
// a 307, which turns the sitemap entry into a redirect (#814). The fallbacks
// live in the component.
const searchParamsSchema = z.object({
  tab: z.enum(['characters', 'talent']).optional(),
  /** The open tab's search box; switching tabs clears it. */
  q: z.string().optional(),
  /** Talent tab. */
  filter: z.enum(['all', 'favorites']).optional(),
});

export const Route = createFileRoute('/_app/characters/')({
  validateSearch: searchParamsSchema,
  component: CharactersPage,
  staticData: { breadcrumb: 'Characters' },
});

function CharactersPage() {
  const search = Route.useSearch();
  // Not onEnter: the router skips it on the first, server-rendered load.
  rememberLibrarySearch(search);
  const navigate = Route.useNavigate();
  const { data: session, isPending } = useAuthSession();
  const isAuthenticated = !!session;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Signed out, the page is the public talent catalogue.
  const tab = search.tab ?? (isAuthenticated ? 'characters' : 'talent');
  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      {tab === 'talent' ? (
        <PageIntro title="Talent Library">
          {isAuthenticated
            ? "Manage your team's talent library for consistent AI-generated content."
            : 'Browse system talent. Sign in to add your own and keep characters consistent across sequences.'}
        </PageIntro>
      ) : (
        <PageIntro title="Characters">
          Every character your team has. Use one in a script with @.
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
            className="gap-4"
          >
            {/* Pinned: the tabs, the open tab's add button and its own
                search (not the app-wide one). */}
            <div className="sticky top-0 z-10 flex flex-col gap-3 bg-background py-2">
              <div className="flex items-center justify-between gap-3">
                <TabsList>
                  <TabsTrigger value="characters">Characters</TabsTrigger>
                  <TabsTrigger value="talent">Talent</TabsTrigger>
                </TabsList>
                {tab === 'talent' ? (
                  <AddTalentDialog />
                ) : (
                  isAuthenticated && <NewCharacterDialog />
                )}
              </div>
              {(tab === 'talent' || isAuthenticated) && (
                <InputGroup className="sm:max-w-xs">
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  {/* Uncontrolled, so the URL trails the keystrokes; keyed
                      by tab so switching tabs empties it. */}
                  <InputGroupInput
                    key={tab}
                    type="search"
                    placeholder={`Search ${tab}`}
                    aria-label={`Search ${tab}`}
                    defaultValue={search.q}
                    onChange={(event) =>
                      void navigate({
                        search: (prev) => ({
                          ...prev,
                          q: event.target.value || undefined,
                        }),
                        replace: true,
                      })
                    }
                  />
                </InputGroup>
              )}
            </div>
            <TabsContent value="characters" className="flex flex-col gap-6">
              {isAuthenticated ? (
                <Suspense fallback={<LibraryGridSkeleton />}>
                  <TeamCharacterList
                    scrollRef={scrollRef}
                    query={search.q ?? ''}
                  />
                </Suspense>
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
                query={search.q ?? ''}
                filter={search.filter ?? 'all'}
                onFilterChange={(filter) =>
                  void navigate({
                    search: { tab: 'talent', filter, q: search.q },
                  })
                }
              />
            </TabsContent>
          </Tabs>
        )}
      </PageContainer>
    </div>
  );
}
