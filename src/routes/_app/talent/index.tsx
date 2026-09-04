import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { AddTalentDialog } from '@/components/talent-library/add-talent-dialog';
import { TalentLibraryFilters } from '@/components/talent-library/talent-library-filters';
import { TalentLibraryList } from '@/components/talent-library/talent-library-list';
import { PageContainer } from '@/components/layout/page-container';
import { PageIntro } from '@/components/typography/page-intro';
import { EmptyState } from '@/components/ui/empty-state';
import { useTalent } from '@/hooks/use-talent';
import { createFileRoute } from '@tanstack/react-router';
import { User } from 'lucide-react';
import { z } from 'zod';

// No `.default()` here: a default makes the router rewrite bare /talent to
// /talent?filter=all with a 307, which turns the sitemap entry into a
// redirect (#814). The fallback lives in the component instead.
const searchParamsSchema = z.object({
  filter: z.enum(['all', 'favorites']).optional(),
});

export const Route = createFileRoute('/_app/talent/')({
  validateSearch: searchParamsSchema,
  component: TalentPage,
  staticData: { breadcrumb: 'Talent' },
});

function TalentPage() {
  const { filter = 'all' } = Route.useSearch();
  const { isAuthenticated } = useAuthGate();
  const {
    data: talent,
    isLoading,
    error,
  } = useTalent({
    favoritesOnly: filter === 'favorites',
  });

  // Anonymous visitors browse the public ("system") talent catalogue and can
  // open the dialog; the actual add prompts a login (gated inside
  // AddTalentDialog).
  const addAction = <AddTalentDialog />;

  return (
    <div className="h-full overflow-auto">
      <PageIntro title="Talent Library" actions={addAction}>
        {isAuthenticated
          ? "Manage your team's talent library for consistent AI-generated content."
          : 'Browse system talent. Sign in to add your own and keep characters consistent across sequences.'}
      </PageIntro>
      <PageContainer padding="none" className="pb-8">
        {isAuthenticated && <TalentLibraryFilters currentFilter={filter} />}

        {!isLoading && talent && talent.length === 0 ? (
          <EmptyState
            icon={<User className="h-12 w-12" />}
            title={isAuthenticated ? 'No talent yet' : 'No system talent yet'}
            description={
              isAuthenticated
                ? 'Add talent to your library to maintain visual consistency across your sequences.'
                : 'Check back soon, or sign in to build your own talent library.'
            }
            action={addAction}
          />
        ) : (
          <TalentLibraryList
            talent={talent}
            isLoading={isLoading}
            error={error}
          />
        )}
      </PageContainer>
    </div>
  );
}
