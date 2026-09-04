import { ValidationError } from '@/lib/errors';
import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOAuthClientPublic = vi.fn();
const getOAuthConsents = vi.fn();
const deleteOAuthConsent = vi.fn();
const oauth2Consent = vi.fn();
const revokeOAuthGrantTokens = vi.fn();
const resolveUserTeam = vi.fn();

vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({
    api: {
      getOAuthClientPublic,
      getOAuthConsents,
      deleteOAuthConsent,
      oauth2Consent,
    },
  }),
}));
vi.doMock('@/lib/db/scoped', () => ({
  resolveUserTeam,
  revokeOAuthGrantTokens,
}));

const {
  consentRedirectUrl,
  decideOAuthConsent,
  loadOAuthConsentContext,
  oauthProviderUserMessage,
  performAuthorizedAppRevoke,
  toClientSummary,
} = await import('./oauth-consent');

const client = {
  client_id: 'c1',
  client_name: 'Acme',
  redirect_uris: ['https://first.example/cb', 'https://attacker.example/cb'],
};

beforeEach(() => {
  getOAuthClientPublic.mockReset();
  getOAuthConsents.mockReset();
  deleteOAuthConsent.mockReset();
  oauth2Consent.mockReset();
  revokeOAuthGrantTokens.mockReset();
  resolveUserTeam.mockReset();
  resolveUserTeam.mockResolvedValue({ teamId: 'team_1', teamName: 'T' });
});

describe('toClientSummary', () => {
  it('shows the request redirect_uri origin, not the first registered URI', () => {
    expect(
      toClientSummary(client, 'https://attacker.example/cb').redirectOrigin
    ).toBe('https://attacker.example');
  });
});

describe('loadOAuthConsentContext', () => {
  it('returns client: null for a missing client, not a throw', async () => {
    getOAuthClientPublic.mockRejectedValueOnce(
      new APIError('NOT_FOUND', { message: 'missing' })
    );
    const result = await loadOAuthConsentContext({
      userId: 'user_1',
      teamId: 'team_1',
      clientId: 'gone',
      scope: '',
      headers: new Headers(),
    });
    expect(result.client).toBeNull();
  });

  it('rethrows non-404 client lookup errors', async () => {
    getOAuthClientPublic.mockRejectedValueOnce(
      new APIError('INTERNAL_SERVER_ERROR', { message: 'db' })
    );
    await expect(
      loadOAuthConsentContext({
        userId: 'user_1',
        teamId: 'team_1',
        clientId: 'c1',
        scope: '',
        headers: new Headers(),
      })
    ).rejects.toBeInstanceOf(APIError);
  });
});

describe('performAuthorizedAppRevoke', () => {
  it('revokes tokens before deleting the consent', async () => {
    const order: string[] = [];
    getOAuthConsents.mockResolvedValueOnce([
      { id: 'consent_1', clientId: 'c1' },
    ]);
    revokeOAuthGrantTokens.mockImplementation(async () => {
      order.push('revoke');
    });
    deleteOAuthConsent.mockImplementation(async () => {
      order.push('delete');
    });
    await performAuthorizedAppRevoke({
      userId: 'user_1',
      consentId: 'consent_1',
      clientId: 'c1',
      headers: new Headers(),
    });
    expect(order).toEqual(['revoke', 'delete']);
    expect(revokeOAuthGrantTokens).toHaveBeenCalledWith('user_1', 'c1');
  });

  it('still revokes tokens when the consent row is already gone', async () => {
    getOAuthConsents.mockResolvedValueOnce([]);
    await performAuthorizedAppRevoke({
      userId: 'user_1',
      consentId: 'consent_1',
      clientId: 'c1',
      headers: new Headers(),
    });
    expect(revokeOAuthGrantTokens).toHaveBeenCalledWith('user_1', 'c1');
    expect(deleteOAuthConsent).not.toHaveBeenCalled();
  });
});

describe('oauthProviderUserMessage', () => {
  it('prefers error_description when message is empty', () => {
    const error = new APIError('BAD_REQUEST', {
      error: 'invalid_request',
      error_description: 'missing oauth query',
    });
    expect(oauthProviderUserMessage(error, 'fallback')).toBe(
      'missing oauth query'
    );
  });

  it('maps invalid_signature to the stale-request fallback', () => {
    const error = new APIError('BAD_REQUEST', { error: 'invalid_signature' });
    expect(oauthProviderUserMessage(error, 'fallback')).toBe('fallback');
  });
});

describe('consentRedirectUrl', () => {
  it('accepts url or redirect_uri', () => {
    expect(consentRedirectUrl({ url: 'https://a.example/cb' })).toBe(
      'https://a.example/cb'
    );
    expect(consentRedirectUrl({ redirect_uri: 'https://b.example/cb' })).toBe(
      'https://b.example/cb'
    );
    expect(consentRedirectUrl({})).toBeNull();
  });

  it('reads Location from a 302 Response', () => {
    expect(
      consentRedirectUrl(
        new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1:8765/cb?code=1' },
        })
      )
    ).toBe('http://127.0.0.1:8765/cb?code=1');
  });
});

describe('decideOAuthConsent', () => {
  const signedQuery =
    '?client_id=c1&sig=deadbeef&exp=1700000000&resource=https://x/api/v1';

  it('accepts redirect_uri when the client does not set url', async () => {
    oauth2Consent.mockResolvedValueOnce({
      redirect_uri: 'http://127.0.0.1:8765/cb?code=2',
    });
    const result = await decideOAuthConsent({
      userId: 'user_1',
      teamId: 'team_1',
      accept: true,
      oauthQuery: 'client_id=c1',
      headers: new Headers(),
    });
    expect(result.url).toBe('http://127.0.0.1:8765/cb?code=2');
  });

  it('unpacks a packed q before calling the provider', async () => {
    const { packOAuthQuery } = await import('./oauth-query-snapshot');
    oauth2Consent.mockResolvedValueOnce({
      url: 'http://127.0.0.1:8765/cb?code=3',
    });
    await decideOAuthConsent({
      userId: 'user_1',
      teamId: 'team_1',
      accept: true,
      oauthQuery: `?q=${packOAuthQuery(signedQuery)}`,
      headers: new Headers(),
    });
    expect(oauth2Consent).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: {
        accept: true,
        oauth_query: signedQuery.slice(1),
      },
    });
  });

  it('asks the provider for a JSON redirect instead of a 302', async () => {
    oauth2Consent.mockResolvedValueOnce({
      url: 'http://127.0.0.1:8765/cb?code=4',
    });
    await decideOAuthConsent({
      userId: 'user_1',
      teamId: 'team_1',
      accept: true,
      oauthQuery: 'client_id=c1',
      headers: new Headers({ accept: 'text/html' }),
    });
    const passed = oauth2Consent.mock.calls[0]?.[0];
    expect(passed?.headers).toBeInstanceOf(Headers);
    expect(passed?.headers.get('Accept')).toBe('application/json');
    expect(passed?.headers.get('Sec-Fetch-Mode')).toBe('cors');
  });

  it('uses Location when the provider throws a redirect Response', async () => {
    oauth2Consent.mockRejectedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1:8765/cb?code=5' },
      })
    );
    const result = await decideOAuthConsent({
      userId: 'user_1',
      teamId: 'team_1',
      accept: true,
      oauthQuery: 'client_id=c1',
      headers: new Headers(),
    });
    expect(result.url).toBe('http://127.0.0.1:8765/cb?code=5');
  });

  it('strips a leading ? and returns the provider redirect', async () => {
    oauth2Consent.mockResolvedValueOnce({
      url: 'http://127.0.0.1:8765/cb?code=1',
    });
    const result = await decideOAuthConsent({
      userId: 'user_1',
      teamId: 'team_1',
      accept: true,
      oauthQuery: signedQuery,
      headers: new Headers(),
    });
    expect(result.url).toBe('http://127.0.0.1:8765/cb?code=1');
    expect(oauth2Consent).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: {
        accept: true,
        oauth_query: signedQuery.slice(1),
      },
    });
  });

  it('surfaces a provider error_description as ValidationError', async () => {
    oauth2Consent.mockRejectedValueOnce(
      new APIError('BAD_REQUEST', {
        error: 'invalid_request',
        error_description: 'missing oauth query',
      })
    );
    await expect(
      decideOAuthConsent({
        userId: 'user_1',
        teamId: 'team_1',
        accept: true,
        oauthQuery: 'client_id=c1',
        headers: new Headers(),
      })
    ).rejects.toMatchObject({
      name: ValidationError.name,
      message: 'missing oauth query',
    });
  });
});
