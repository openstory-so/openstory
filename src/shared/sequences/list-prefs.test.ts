/**
 * Sequences list prefs (#1314): URL search is the live snapshot; localStorage
 * is what a bare /sequences visit restores. URL params never blend with
 * stored values — a shared `?q=` must not turn on this browser's support mode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
const localStorageMock = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
};

const storedPrefs = {
  search: 'night diner',
  analysisModel: 'analysis-1',
  imageModel: 'image-1',
  aspectRatio: '9:16' as const,
  styleId: 'style-1',
  supportMode: true,
  hideInternal: true,
};

describe('sequences list prefs', () => {
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', { localStorage: localStorageMock });
    vi.stubGlobal('localStorage', localStorageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads empty URL search as the default list prefs', async () => {
    const { prefsFromSearch, DEFAULT_SEQUENCES_LIST_PREFS } =
      await import('./list-prefs');

    expect(prefsFromSearch({})).toEqual(DEFAULT_SEQUENCES_LIST_PREFS);
  });

  it('takes search from q, and user over q, forcing support on for the deep link', async () => {
    const { prefsFromSearch } = await import('./list-prefs');

    expect(prefsFromSearch({ q: 'cat' })).toMatchObject({
      search: 'cat',
      supportMode: false,
    });
    expect(
      prefsFromSearch({
        user: 'ada@example.com',
        q: 'ignored',
        support: false,
        hideInternal: true,
      })
    ).toEqual({
      search: 'ada@example.com',
      analysisModel: null,
      imageModel: null,
      aspectRatio: null,
      styleId: null,
      supportMode: true,
      hideInternal: false,
    });
  });

  it('treats any list param as a complete URL snapshot', async () => {
    const { searchSpecifiesPrefs } = await import('./list-prefs');

    expect(searchSpecifiesPrefs({})).toBe(false);
    expect(searchSpecifiesPrefs({ q: 'x' })).toBe(true);
    expect(searchSpecifiesPrefs({ support: true })).toBe(true);
    expect(searchSpecifiesPrefs({ user: 'ada@example.com' })).toBe(true);
    expect(searchSpecifiesPrefs({ hideInternal: true })).toBe(true);
  });

  it('restores stored prefs only when the URL is bare', async () => {
    const { resolveSequencesListPrefs } = await import('./list-prefs');

    expect(resolveSequencesListPrefs({}, storedPrefs)).toEqual(storedPrefs);
    expect(resolveSequencesListPrefs({}, null)).toEqual({
      search: '',
      analysisModel: null,
      imageModel: null,
      aspectRatio: null,
      styleId: null,
      supportMode: false,
      hideInternal: false,
    });
  });

  it('does not blend a partial URL with stored support mode or search', async () => {
    const { resolveSequencesListPrefs } = await import('./list-prefs');

    expect(resolveSequencesListPrefs({ q: 'shared' }, storedPrefs)).toEqual({
      search: 'shared',
      analysisModel: null,
      imageModel: null,
      aspectRatio: null,
      styleId: null,
      supportMode: false,
      hideInternal: false,
    });
    expect(
      resolveSequencesListPrefs({ user: 'ada@example.com' }, storedPrefs)
    ).toMatchObject({
      search: 'ada@example.com',
      supportMode: true,
      hideInternal: false,
      analysisModel: null,
    });
  });

  it('omits default prefs from the URL so /sequences stays canonical', async () => {
    const { prefsToSearch, DEFAULT_SEQUENCES_LIST_PREFS } =
      await import('./list-prefs');

    expect(prefsToSearch(DEFAULT_SEQUENCES_LIST_PREFS)).toEqual({});
    expect(
      prefsToSearch({
        search: 'cat',
        analysisModel: 'analysis-1',
        imageModel: null,
        aspectRatio: '16:9',
        styleId: 'style-1',
        supportMode: true,
        hideInternal: true,
      })
    ).toEqual({
      q: 'cat',
      analysisModel: 'analysis-1',
      aspectRatio: '16:9',
      styleId: 'style-1',
      support: true,
      hideInternal: true,
    });
  });

  it('keeps the admin user param only while search still matches and support is on', async () => {
    const { prefsToSearch } = await import('./list-prefs');
    const user = 'ada@example.com';

    expect(
      prefsToSearch(
        {
          search: user,
          analysisModel: null,
          imageModel: null,
          aspectRatio: null,
          styleId: null,
          supportMode: true,
          hideInternal: false,
        },
        user
      )
    ).toEqual({ user });

    expect(
      prefsToSearch(
        {
          search: 'other',
          analysisModel: null,
          imageModel: null,
          aspectRatio: null,
          styleId: null,
          supportMode: true,
          hideInternal: false,
        },
        user
      )
    ).toEqual({ q: 'other', support: true });

    expect(
      prefsToSearch(
        {
          search: user,
          analysisModel: null,
          imageModel: null,
          aspectRatio: null,
          styleId: null,
          supportMode: false,
          hideInternal: false,
        },
        user
      )
    ).toEqual({ q: user });
  });

  it('round-trips prefs through localStorage and rejects garbage', async () => {
    const {
      loadSequencesListPrefs,
      saveSequencesListPrefs,
      SEQUENCES_LIST_PREFS_KEY,
    } = await import('./list-prefs');

    expect(loadSequencesListPrefs()).toBeNull();
    saveSequencesListPrefs(storedPrefs);
    expect(loadSequencesListPrefs()).toEqual(storedPrefs);

    localStorage.setItem(SEQUENCES_LIST_PREFS_KEY, '{not json');
    expect(loadSequencesListPrefs()).toBeNull();

    localStorage.setItem(
      SEQUENCES_LIST_PREFS_KEY,
      JSON.stringify({ search: 'ok', aspectRatio: 'not-a-ratio' })
    );
    expect(loadSequencesListPrefs()).toMatchObject({
      search: 'ok',
      aspectRatio: null,
      supportMode: false,
    });
  });
});
