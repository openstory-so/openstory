import { useIsomorphicLayoutEffect } from '@/hooks/use-isomorphic-layout-effect';
import {
  isDefaultSequencesListPrefs,
  loadSequencesListPrefs,
  prefsFromSearch,
  prefsToSearch,
  resolveSequencesListPrefs,
  saveSequencesListPrefs,
  searchSpecifiesPrefs,
  type SequencesListPrefs,
  type SequencesListSearch,
} from '@/lib/sequences/list-prefs';
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
