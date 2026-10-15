/**
 * The Characters page's tab and search as last seen, so a detail page's way
 * back lands on the list the user left. Per tab, lost on reload.
 */
type LibrarySearch = {
  tab?: 'characters' | 'talent';
  q?: string;
  filter?: 'all' | 'favorites';
};

let last: LibrarySearch = {};

export const rememberLibrarySearch = (search: LibrarySearch) => {
  last = search;
};

/** Back to a tab: its last search if that tab was the one left open. */
export const librarySearchFor = (
  tab: 'characters' | 'talent'
): LibrarySearch =>
  (last.tab ?? 'characters') === tab ? last : tab === 'talent' ? { tab } : {};
