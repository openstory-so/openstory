import { NewCharacterDialog } from '@/cast/ui/character-library/new-character-dialog';
import { TeamCharacterList } from '@/cast/ui/character-library/team-character-list';
import { LibraryGridSkeleton } from '@/cast/ui/library-virtual-grid';
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
import { PageIntro } from '@/ui/typography/page-intro';
import { createFileRoute } from '@tanstack/react-router';
import { Search, User } from 'lucide-react';
import { Suspense, useRef } from 'react';
import { z } from 'zod';

const searchParamsSchema = z.object({
  q: z.string().optional(),
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
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="h-full overflow-auto">
      <PageIntro
        title="Characters"
        actions={session ? <NewCharacterDialog /> : undefined}
      >
        Every character your team has. Use one in a script with @.
      </PageIntro>
      <PageContainer padding="none" className="pb-8">
        {session ? (
          <div className="flex flex-col gap-6">
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              {/* Uncontrolled, so the URL trails the keystrokes. */}
              <InputGroupInput
                type="search"
                placeholder="Search characters"
                aria-label="Search characters"
                defaultValue={search.q}
                onChange={(event) =>
                  void navigate({
                    search: { q: event.target.value || undefined },
                    replace: true,
                  })
                }
              />
            </InputGroup>
            <Suspense fallback={<LibraryGridSkeleton />}>
              <TeamCharacterList scrollRef={scrollRef} query={search.q ?? ''} />
            </Suspense>
          </div>
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
      </PageContainer>
    </div>
  );
}
