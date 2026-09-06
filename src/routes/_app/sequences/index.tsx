import { SignInPrompt } from '@/components/auth/sign-in-prompt';
import { EvalView } from '@/components/eval/eval-view';
import { PageContainer } from '@/components/layout/page-container';
import { PageIntro } from '@/components/typography/page-intro';
import { useUser } from '@/hooks/use-user';
import {
  sequencesListSearchSchema,
  isDefaultSequencesListPrefs,
  loadSequencesListPrefs,
  prefsFromSearch,
  prefsToSearch,
  resolveSequencesListPrefs,
  saveSequencesListPrefs,
  searchSpecifiesPrefs,
  type SequencesListPrefs,
  type SequencesListSearch,
} from '@/components/sequence/list-prefs';
import { createFileRoute } from '@tanstack/react-router';
import { Video } from 'lucide-react';
import { useIsomorphicLayoutEffect } from '@/hooks/use-isomorphic-layout-effect';
import { useCallback, useRef } from 'react';

type SequencesListNavigate = (opts: {
  search: SequencesListSearch;
  replace: boolean;
}) => unknown;

/**
 * URL is the live snapshot of sequences-list prefs. localStorage fills a bare
 * `/sequences` visit (sidebar / breadcrumb) so filters, search, and support
 * mode survive leaving the page.
 *
 * `navigate` must be the sequences route's `Route.useNavigate()` so search
 * writes land on this index, not a sibling like `/sequences/$id`.
 */
export function useSequencesListPrefs(
  search: SequencesListSearch,
  navigate: SequencesListNavigate
) {
  const restored = useRef(false);
  const prefs = prefsFromSearch(search);

  useIsomorphicLayoutEffect(() => {
    if (restored.current) return;
    restored.current = true;

    if (searchSpecifiesPrefs(search)) {
      saveSequencesListPrefs(prefsFromSearch(search));
      return;
    }

    const resolved = resolveSequencesListPrefs(
      search,
      loadSequencesListPrefs()
    );
    if (isDefaultSequencesListPrefs(resolved)) return;
    const nextSearch = prefsToSearch(resolved);
    if (!searchSpecifiesPrefs(nextSearch)) return;
    saveSequencesListPrefs(resolved);
    void navigate({ search: nextSearch, replace: true });
  }, [navigate, search]);

  const setPrefs = useCallback(
    (next: SequencesListPrefs) => {
      saveSequencesListPrefs(next);
      void navigate({
        search: prefsToSearch(next, search.user),
        replace: true,
      });
    },
    [navigate, search.user]
  );

  return { prefs, setPrefs };
}

export const Route = createFileRoute('/_app/sequences/')({
  validateSearch: sequencesListSearchSchema,
  component: SequencesPage,
  staticData: { breadcrumb: 'Sequences' },
});

function SequencesPage() {
  const search = Route.useSearch();
  const { data: currentUser } = useUser();

  return (
    <>
      <PageIntro title="Your Sequences" maxWidth="full">
        Your films, from first draft to final cut.
      </PageIntro>
      <PageContainer
        maxWidth="full"
        padding="none"
        className="flex min-h-0 flex-1 flex-col overflow-hidden pb-4"
      >
        {currentUser ? (
          <SequencesEvalView search={search} />
        ) : (
          <SignInPrompt
            icon={<Video className="h-12 w-12" />}
            title="Sign in to see your sequences"
            description="Your generated sequences live here once you create an account."
          />
        )}
      </PageContainer>
    </>
  );
}

function SequencesEvalView({
  search,
}: {
  search: ReturnType<typeof Route.useSearch>;
}) {
  const navigate = Route.useNavigate();
  const { prefs, setPrefs } = useSequencesListPrefs(search, navigate);

  return <EvalView search={search} prefs={prefs} setPrefs={setPrefs} />;
}
