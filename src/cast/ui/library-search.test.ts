import { describe, expect, it, vi } from 'vitest';

describe('library search memory', () => {
  it('remembers nothing on the server, where requests share the module', async () => {
    vi.resetModules();
    vi.stubGlobal('window', undefined);
    const { librarySearchFor, rememberLibrarySearch } =
      await import('./library-search');
    rememberLibrarySearch({ q: 'secret' });
    expect(librarySearchFor()).toEqual({});
    vi.unstubAllGlobals();
  });

  it('returns the last search in the browser', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    const { librarySearchFor, rememberLibrarySearch } =
      await import('./library-search');
    rememberLibrarySearch({ q: 'blonde' });
    expect(librarySearchFor()).toEqual({ q: 'blonde' });
    vi.unstubAllGlobals();
  });
});
