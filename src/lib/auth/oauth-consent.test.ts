import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getOAuthClientPublic = vi.fn();
const getOAuthConsents = vi.fn();
const deleteOAuthConsent = vi.fn();
const revokeOAuthGrantTokens = vi.fn();
const resolveUserTeam = vi.fn();

vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({
    api: {
      getOAuthClientPublic,
      getOAuthConsents,
      deleteOAuthConsent,
    },
  }),
}));
vi.doMock('@/lib/db/scoped', () => ({
  resolveUserTeam,
  revokeOAuthGrantTokens,
}));
const { loadOAuthConsentContext, performAuthorizedAppRevoke, toClientSummary } =
  await import('./oauth-consent');

const client = {
  client_id: 'c1',
  client_name: 'Acme',
  redirect_uris: ['https://first.example/cb', 'https://attacker.example/cb'],
};

beforeEach(() => {
  getOAuthClientPublic.mockReset();
  getOAuthConsents.mockReset();
  deleteOAuthConsent.mockReset();
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
