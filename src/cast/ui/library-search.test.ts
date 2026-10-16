import { describe, expect, it, vi } from 'vitest';

describe('library search memory', () => {
  it('remembers nothing on the server, where requests share the module', async () => {
    vi.resetModules();
    vi.stubGlobal('window', undefined);
    const { librarySearchFor, rememberLibrarySearch } =
      await import('./library-search');
    rememberLibrarySearch({ tab: 'talent', q: 'secret' });
    expect(librarySearchFor('talent')).toEqual({ tab: 'talent' });
    vi.unstubAllGlobals();
  });

  it('returns a tab to its last search in the browser', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    const { librarySearchFor, rememberLibrarySearch } =
      await import('./library-search');
    rememberLibrarySearch({ tab: 'talent', q: 'blonde' });
    expect(librarySearchFor('talent')).toEqual({ tab: 'talent', q: 'blonde' });
    expect(librarySearchFor('characters')).toEqual({});
    vi.unstubAllGlobals();
  });
});
