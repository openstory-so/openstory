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
});

describe('decideOAuthConsent', () => {
  const signedQuery =
    '?client_id=c1&sig=deadbeef&exp=1700000000&resource=https://x/api/v1';

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
