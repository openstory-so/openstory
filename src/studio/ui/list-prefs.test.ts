/**
 * Images / Videos list prefs (#1568): URL search is the live snapshot;
 * a cookie restores support mode on a bare /images or /clips visit.
 * `sort` / `favorites` never turn on this browser's support mode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.doMock('@/ui/cookie', () => ({
  readCookie: (name: string) => mem.get(name),
  writeCookie: (name: string, value: string) => {
    mem.set(name, value);
  },
}));

const storedPrefs = {
  search: 'ada@example.com',
  supportMode: true,
  hideInternal: true,
};

describe('studio list prefs', () => {
  beforeEach(() => {
    mem.clear();
  });

  it('reads empty URL search as the default list prefs', async () => {
    const { prefsFromSearch, DEFAULT_STUDIO_LIST_PREFS } =
      await import('./list-prefs');

    expect(prefsFromSearch({})).toEqual(DEFAULT_STUDIO_LIST_PREFS);
  });

  it('takes search from q, and user over q, forcing support on for the deep link', async () => {
    const { prefsFromSearch } = await import('./list-prefs');

    expect(prefsFromSearch({ q: 'fox' })).toMatchObject({
      search: 'fox',
      supportMode: false,
    });
    expect(
      prefsFromSearch({
        user: 'ada@example.com',
        q: 'ignored',
        support: false,
        hideInternal: true,
        sort: 'oldest',
        favorites: true,
      })
    ).toEqual({
      search: 'ada@example.com',
      supportMode: true,
      hideInternal: false,
      sort: 'oldest',
      favorites: true,
    });
  });

  it('treats support params as a complete URL snapshot, not sort or favorites', async () => {
    const { searchSpecifiesSupportPrefs } = await import('./list-prefs');

    expect(searchSpecifiesSupportPrefs({})).toBe(false);
    expect(searchSpecifiesSupportPrefs({ sort: 'oldest' })).toBe(false);
    expect(searchSpecifiesSupportPrefs({ favorites: true })).toBe(false);
    expect(searchSpecifiesSupportPrefs({ q: 'x' })).toBe(true);
    expect(searchSpecifiesSupportPrefs({ support: true })).toBe(true);
    expect(searchSpecifiesSupportPrefs({ user: 'ada@example.com' })).toBe(true);
  });

  it('restores stored support prefs onto a bare visit, keeping URL sort', async () => {
    const { resolveStudioListPrefs } = await import('./list-prefs');

    expect(resolveStudioListPrefs({}, storedPrefs)).toEqual({
      search: 'ada@example.com',
      supportMode: true,
      hideInternal: true,
      sort: 'newest',
      favorites: false,
    });
    expect(resolveStudioListPrefs({ sort: 'oldest' }, storedPrefs)).toEqual({
      search: 'ada@example.com',
      supportMode: true,
      hideInternal: true,
      sort: 'oldest',
      favorites: false,
    });
    expect(resolveStudioListPrefs({}, null)).toEqual({
      search: '',
      supportMode: false,
      hideInternal: false,
      sort: 'newest',
      favorites: false,
    });
  });

  it('does not blend a support URL with stored search', async () => {
    const { resolveStudioListPrefs } = await import('./list-prefs');

    expect(resolveStudioListPrefs({ q: 'shared' }, storedPrefs)).toEqual({
      search: 'shared',
      supportMode: false,
      hideInternal: false,
      sort: 'newest',
      favorites: false,
    });
    expect(
      resolveStudioListPrefs({ user: 'ada@example.com' }, storedPrefs)
    ).toMatchObject({
      search: 'ada@example.com',
      supportMode: true,
      hideInternal: false,
    });
  });

  it('omits default prefs from the URL so /images stays canonical', async () => {
    const { prefsToSearch, DEFAULT_STUDIO_LIST_PREFS } =
      await import('./list-prefs');

    expect(prefsToSearch(DEFAULT_STUDIO_LIST_PREFS)).toEqual({});
    expect(
      prefsToSearch({
        search: 'fox',
        supportMode: true,
        hideInternal: true,
        sort: 'oldest',
        favorites: true,
      })
    ).toEqual({
      q: 'fox',
      support: true,
      hideInternal: true,
      sort: 'oldest',
      favorites: true,
    });
  });

  it('keeps the admin user param only while search still matches and support is on', async () => {
    const { prefsToSearch } = await import('./list-prefs');
    const user = 'ada@example.com';

    expect(
      prefsToSearch(
        {
          search: user,
          supportMode: true,
          hideInternal: false,
          sort: 'newest',
          favorites: false,
        },
        user
      )
    ).toEqual({ user });

    expect(
      prefsToSearch(
        {
          search: 'other',
          supportMode: true,
          hideInternal: false,
          sort: 'newest',
          favorites: false,
        },
        user
      )
    ).toEqual({ q: 'other', support: true });

    expect(
      prefsToSearch(
        {
          search: user,
          supportMode: false,
          hideInternal: false,
          sort: 'newest',
          favorites: false,
        },
        user
      )
    ).toEqual({ q: user });
  });

  it('round-trips support prefs through the cookie and rejects garbage', async () => {
    const {
      loadStudioListPrefs,
      saveStudioListPrefs,
      STUDIO_LIST_PREFS_COOKIE,
    } = await import('./list-prefs');

    expect(loadStudioListPrefs()).toBeNull();
    saveStudioListPrefs({
      search: storedPrefs.search,
      supportMode: true,
      hideInternal: true,
      sort: 'oldest',
      favorites: true,
    });
    expect(loadStudioListPrefs()).toEqual(storedPrefs);

    mem.set(STUDIO_LIST_PREFS_COOKIE, '{not json');
    expect(loadStudioListPrefs()).toBeNull();
  });

  it('sends a bare visit to the remembered support prefs once, keeping sort', async () => {
    const { rememberStudioListPrefs, saveStudioListPrefs } =
      await import('./list-prefs');

    expect(rememberStudioListPrefs({ sort: 'oldest' }, false)).toBeNull();

    expect(rememberStudioListPrefs({ support: true }, true)).toBeNull();
    expect(rememberStudioListPrefs({}, false)).toBeNull();
    expect(rememberStudioListPrefs({ support: true }, false)).toBeNull();
    const target = rememberStudioListPrefs({ sort: 'oldest' }, false);
    expect(target).toEqual({ support: true, sort: 'oldest' });
    // The redirect target names support prefs, so it does not redirect again.
    expect(target && rememberStudioListPrefs(target, false)).toBeNull();

    saveStudioListPrefs({
      search: '',
      supportMode: false,
      hideInternal: false,
      sort: 'oldest',
      favorites: true,
    });
    expect(rememberStudioListPrefs({ sort: 'oldest' }, false)).toBeNull();
  });
});
