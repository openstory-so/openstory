import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTH_COOKIE_PREFIX,
  lastUsedLoginMethodCookieName,
  resolveAuthCookiePrefix,
  worktreeAuthCookiePrefix,
} from './cookie-prefix';

describe('worktreeAuthCookiePrefix', () => {
  it('namespaces published FNV-1a 32-bit vectors as cookie-name tokens', () => {
    expect(worktreeAuthCookiePrefix('')).toBe('ba-811c9dc5');
    expect(worktreeAuthCookiePrefix('a')).toBe('ba-e40c292c');
    expect(worktreeAuthCookiePrefix('foobar')).toBe('ba-bf9cf968');
  });

  it('differs across worktree paths and is stable for the same path', () => {
    const a = worktreeAuthCookiePrefix(
      '/Users/tom/.herdr/worktrees/openstory/1288-worktree-auth-cookies'
    );
    const b = worktreeAuthCookiePrefix(
      '/Users/tom/.herdr/worktrees/openstory/other-issue'
    );
    expect(a).toBe('ba-419ef3f1');
    expect(b).toBe('ba-51ee7169');
    expect(a).not.toBe(b);
    expect(
      worktreeAuthCookiePrefix(
        '/Users/tom/.herdr/worktrees/openstory/1288-worktree-auth-cookies'
      )
    ).toBe(a);
  });
});

describe('resolveAuthCookiePrefix', () => {
  it('keeps the Better Auth default outside vite dev', () => {
    expect(
      resolveAuthCookiePrefix({
        isDev: false,
        injectedPrefix: 'ba-deadbeef',
      })
    ).toBe(DEFAULT_AUTH_COOKIE_PREFIX);
  });

  it('uses the injected worktree prefix in vite dev', () => {
    expect(
      resolveAuthCookiePrefix({
        isDev: true,
        injectedPrefix: 'ba-deadbeef',
      })
    ).toBe('ba-deadbeef');
  });

  it('falls back to the default when vite did not inject a prefix', () => {
    expect(
      resolveAuthCookiePrefix({ isDev: true, injectedPrefix: undefined })
    ).toBe(DEFAULT_AUTH_COOKIE_PREFIX);
  });
});

describe('lastUsedLoginMethodCookieName', () => {
  it('matches Better Auth default name at the stock prefix', () => {
    expect(lastUsedLoginMethodCookieName(DEFAULT_AUTH_COOKIE_PREFIX)).toBe(
      'better-auth.last_used_login_method'
    );
  });

  it('stays under the worktree prefix', () => {
    expect(lastUsedLoginMethodCookieName('ba-deadbeef')).toBe(
      'ba-deadbeef.last_used_login_method'
    );
  });
});
