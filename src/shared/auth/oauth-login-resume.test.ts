import { describe, expect, it } from 'vitest';
import {
  buildAuthorizeResumePath,
  buildLoginRedirect,
  isServerRedirect,
} from './oauth-login-resume';

const signed = () =>
  new URLSearchParams({
    response_type: 'code',
    client_id: 'abc',
    redirect_uri: 'https://client.example/cb',
    scope: 'openid sequences:read',
    state: 'xyz',
    code_challenge: 'cc',
    code_challenge_method: 'S256',
    resource: 'https://openstory.so/mcp',
    exp: '1700000000',
    sig: 'deadbeef',
    ba_iat: '1699999000',
    ba_pl: 'sess',
  });

describe('buildAuthorizeResumePath', () => {
  it('strips the signature params and keeps the client request intact', () => {
    const url = new URL(buildAuthorizeResumePath(signed()) ?? '', 'http://x');
    expect(url.pathname).toBe('/api/auth/oauth2/authorize');
    for (const key of ['sig', 'exp', 'ba_iat', 'ba_pl']) {
      expect(url.searchParams.has(key)).toBe(false);
    }
    expect(url.searchParams.get('client_id')).toBe('abc');
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.get('code_challenge')).toBe('cc');
    expect(url.searchParams.get('resource')).toBe('https://openstory.so/mcp');
  });

  it('drops prompt=login but keeps other prompt values', () => {
    const only = signed();
    only.set('prompt', 'login');
    expect(
      new URL(
        buildAuthorizeResumePath(only) ?? '',
        'http://x'
      ).searchParams.has('prompt')
    ).toBe(false);

    const both = signed();
    both.set('prompt', 'login consent');
    expect(
      new URL(
        buildAuthorizeResumePath(both) ?? '',
        'http://x'
      ).searchParams.get('prompt')
    ).toBe('consent');
  });

  it('returns null when the query is not an authorization request', () => {
    expect(buildAuthorizeResumePath(new URLSearchParams('foo=bar'))).toBeNull();
  });
});

describe('buildLoginRedirect', () => {
  it('wraps the resume path as redirectTo', () => {
    const redirect = buildLoginRedirect(signed());
    const url = new URL(redirect, 'http://x');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('redirectTo')).toMatch(
      /^\/api\/auth\/oauth2\/authorize\?/
    );
  });

  it('falls back to a plain login for a non-OAuth query', () => {
    expect(buildLoginRedirect(new URLSearchParams())).toBe('/login');
  });
});

describe('isServerRedirect', () => {
  it('flags /api/ paths only', () => {
    expect(isServerRedirect('/api/auth/oauth2/authorize?x=1')).toBe(true);
    expect(isServerRedirect('/sequences/abc')).toBe(false);
    expect(isServerRedirect('/')).toBe(false);
  });
});
