/**
 * The Characters page's tab and search as last seen, so a detail page's way
 * back lands on the list the user left. Per tab, lost on reload.
 *
 * Browser only: on the server this module is shared by every request the
 * isolate serves, so one user's search would land in another's links.
 */
type LibrarySearch = {
  tab?: 'characters' | 'talent';
  q?: string;
  filter?: 'all' | 'favorites';
};

let last: LibrarySearch = {};

export const rememberLibrarySearch = (search: LibrarySearch) => {
  if (typeof window === 'undefined') return;
  last = search;
};

/** Back to a tab: its last search if that tab was the one left open. */
export const librarySearchFor = (
  tab: 'characters' | 'talent'
): LibrarySearch =>
  (last.tab ?? 'characters') === tab ? last : tab === 'talent' ? { tab } : {};
