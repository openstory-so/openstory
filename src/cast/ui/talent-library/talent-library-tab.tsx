import { useAuthGate } from '@/platform/ui/auth/auth-gate-provider';
import { SignInButton } from '@/platform/ui/auth/sign-in-button';
import { AddTalentDialog } from '@/cast/ui/talent-library/add-talent-dialog';
import { LibraryFilters } from '@/cast/ui/talent-library/talent-library-filters';
import { TalentLibraryList } from '@/cast/ui/talent-library/talent-library-list';
import { EmptyState } from '@/ui/shadcn/empty-state';
import { useTalent } from '@/cast/ui/use-talent';
import { User } from 'lucide-react';
import type React from 'react';

export type TalentFilter = 'all' | 'favorites';

const TALENT_FILTERS = [
  { value: 'all', label: 'All Talent' },
  { value: 'favorites', label: 'Favorites' },
] as const;

/**
 * The talent library, as the Talent tab of the Characters page (#2017).
 * Anonymous visitors browse the public ("system") talent catalogue and can
 * open the dialog; the actual add prompts a login (gated inside
 * AddTalentDialog).
 */
export const TalentLibraryTab: React.FC<{
  filter: TalentFilter;
  onFilterChange: (filter: TalentFilter) => void;
}> = ({ filter, onFilterChange }) => {
  const { isAuthenticated } = useAuthGate();
  const {
    data: talent,
    isLoading,
    error,
  } = useTalent({ favoritesOnly: filter === 'favorites' });

  return (
    <div className="flex flex-col gap-6">
      {isAuthenticated && (
        <LibraryFilters
          current={filter}
          filters={TALENT_FILTERS}
          onSelect={onFilterChange}
        />
      )}

      {!isLoading && talent && talent.length === 0 ? (
        <EmptyState
          icon={<User className="h-12 w-12" />}
          title={isAuthenticated ? 'No talent yet' : 'No system talent yet'}
          description={
            isAuthenticated
              ? 'Add talent to your library to maintain visual consistency across your sequences.'
              : 'Check back soon, or sign in to build your own talent library.'
          }
          action={isAuthenticated ? <AddTalentDialog /> : <SignInButton />}
        />
      ) : (
        <TalentLibraryList
          talent={talent}
          isLoading={isLoading}
          error={error}
        />
      )}
    </div>
  );
};
