/**
 * The Characters page's search as last seen, so a detail page's way back
 * lands on the list the user left. Lost on reload.
 *
 * Browser only: on the server this module is shared by every request the
 * isolate serves, so one user's search would land in another's links.
 */
type LibrarySearch = {
  q?: string;
};

let last: LibrarySearch = {};

export const rememberLibrarySearch = (search: LibrarySearch) => {
  if (typeof window === 'undefined') return;
  last = search;
};

/** Back to Characters with the search that was left open. */
export const librarySearchFor = (): LibrarySearch => last;
