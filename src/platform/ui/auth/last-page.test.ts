import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginRedirect, rememberLastPage } from './last-page';

const mem = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => mem.get(key) ?? null,
  setItem: (key: string, value: string) => {
    mem.set(key, value);
  },
  removeItem: (key: string) => {
    mem.delete(key);
  },
};

describe('last page', () => {
  beforeEach(() => {
    mem.clear();
    vi.stubGlobal('window', { localStorage: localStorageMock });
    vi.stubGlobal('localStorage', localStorageMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resumes the last page on a bare login', () => {
    rememberLastPage('/sequences/01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(loginRedirect(undefined, true)).toBe(
      '/sequences/01ARZ3NDEKTSV4RRFFQ69G5FAV'
    );
    expect(loginRedirect('  ', true)).toBe(
      '/sequences/01ARZ3NDEKTSV4RRFFQ69G5FAV'
    );
  });

  it('keeps path and search, and drops the hash', () => {
    rememberLastPage('/characters?q=ada#sheet');
    expect(loginRedirect(undefined, true)).toBe('/characters?q=ada');
  });

  it('lets an explicit redirect win, including home', () => {
    rememberLastPage('/sequences');
    expect(loginRedirect('/gift/HELLO', true)).toBe('/gift/HELLO');
    expect(loginRedirect('/', true)).toBe('/');
    expect(loginRedirect('/?style=cinematic#compose', true)).toBe(
      '/?style=cinematic'
    );
  });

  it('does not read storage before hydration', () => {
    rememberLastPage('/gallery');
    expect(loginRedirect(undefined, false)).toBe('/');
  });

  it('does not let home, auth, or server routes erase the last page', () => {
    rememberLastPage('/sequences/01ARZ3NDEKTSV4RRFFQ69G5FAV?shot=2');
    rememberLastPage('/');
    rememberLastPage('/#compose');
    rememberLastPage('/login');
    rememberLastPage('/login?email=a@b.c');
    rememberLastPage('/verify');
    rememberLastPage('/oauth/login');
    rememberLastPage('/api/auth/oauth2/authorize?client_id=abc');
    rememberLastPage('//evil.example/phish');
    expect(loginRedirect(undefined, true)).toBe(
      '/sequences/01ARZ3NDEKTSV4RRFFQ69G5FAV?shot=2'
    );
  });

  it('remembers a composer seed on home', () => {
    rememberLastPage('/?style=noir');
    expect(loginRedirect(undefined, true)).toBe('/?style=noir');
  });

  it('ignores a stored auth path and a blocked storage', () => {
    localStorage.setItem('openstory:last-page', '/login?next=/admin');
    expect(loginRedirect(undefined, true)).toBe('/');

    localStorage.setItem('openstory:last-page', 'https://evil.example/phish');
    // Absolute URLs collapse to a same-origin path. `/phish` is in-app.
    expect(loginRedirect(undefined, true)).toBe('/phish');

    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('blocked');
      },
    });
    expect(() => rememberLastPage('/sequences')).not.toThrow();
    expect(loginRedirect(undefined, true)).toBe('/');
  });
});
