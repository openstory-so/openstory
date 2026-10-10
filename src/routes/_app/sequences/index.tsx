import { SignInPrompt } from '@/platform/ui/auth/sign-in-prompt';
import { EvalView } from '@/sequences/ui/eval/eval-view';
import { PageContainer } from '@/ui/layout/page-container';
import { PageIntro } from '@/ui/typography/page-intro';
import { useUser } from '@/platform/ui/use-user';
import {
  sequencesListSearchSchema,
  prefsFromSearch,
  prefsToSearch,
  rememberSequencesListPrefs,
  saveSequencesListPrefs,
  type SequencesListPrefs,
  type SequencesListSearch,
} from '@/sequences/ui/list-prefs';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Video } from 'lucide-react';
import { useCallback } from 'react';

type SequencesListNavigate = (opts: {
  search: SequencesListSearch;
  replace: boolean;
}) => unknown;

/**
 * URL is the live snapshot of sequences-list prefs. A cookie fills a bare
 * `/sequences` visit (sidebar / breadcrumb) so filters, search, and support
 * mode survive leaving the page; the route's `beforeLoad` restores it.
 *
 * `navigate` must be the sequences route's `Route.useNavigate()` so search
 * writes land on this index, not a sibling like `/sequences/$id`.
 */
function useSequencesListPrefs(
  search: SequencesListSearch,
  navigate: SequencesListNavigate
) {
  const prefs = prefsFromSearch(search);

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
  // Restore remembered prefs before render, on the server for a first visit,
  // so support mode never paints the team's own list first.
  beforeLoad: ({ search, preload }) => {
    const remembered = rememberSequencesListPrefs(search, preload);
    if (remembered) {
      throw redirect({ to: '/sequences', search: remembered, replace: true });
    }
  },
  component: SequencesPage,
  staticData: { breadcrumb: 'Sequences' },
});

function SequencesPage() {
  const search = Route.useSearch();
  const { data: currentUser } = useUser();

  return (
    <>
      <PageIntro title="Sequences" maxWidth="full">
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
