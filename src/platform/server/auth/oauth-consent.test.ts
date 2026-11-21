import { ValidationError } from '@/platform/errors';
import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayGrantStanding } from '@/gateway/server/db/gateway-grants';

const getOAuthClientPublic = vi.fn();
const getOAuthConsents = vi.fn();
const deleteOAuthConsent = vi.fn();
const oauth2Consent = vi.fn();
const authHandler = vi.fn();
const revokeOAuthGrantTokens = vi.fn();
const getUserOrganizationMembership = vi.fn();
const grants = {
  listStandings: vi.fn(async () => [] as GatewayGrantStanding[]),
  setCap: vi.fn(async (_input: unknown) => true),
  revoke: vi.fn(async (_input: unknown) => undefined),
};

vi.doMock('./config', () => ({
  getAuth: () => ({
    api: {
      getOAuthClientPublic,
      getOAuthConsents,
      deleteOAuthConsent,
      oauth2Consent,
    },
    handler: authHandler,
  }),
}));
vi.doMock('@/platform/server/db/scoped', () => ({
  getUserOrganizationMembership,
  listUserOrganizations: async () => [{ id: 'organization_1', name: 'T' }],
  revokeOAuthGrantTokens,
}));

const {
  consentRedirectUrl,
  decideOAuthConsent,
  loadOAuthConsentContext,
  oauthProviderUserMessage,
  performAuthorizedAppRevoke,
  setAuthorizedAppCap,
  toClientSummary,
} = await import('./oauth-consent');
const { consentOrganization } = await import('./oauth-provider');

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
  authHandler.mockReset();
  revokeOAuthGrantTokens.mockReset();
  getUserOrganizationMembership.mockReset();
  grants.listStandings.mockClear();
  grants.setCap.mockClear();
  grants.setCap.mockResolvedValue(true);
  grants.revoke.mockClear();
  getUserOrganizationMembership.mockResolvedValue({
    organizationId: 'organization_1',
    organizationName: 'T',
  });
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
      organizationId: 'organization_1',
      clientId: 'gone',
      scope: '',
      headers: new Headers(),
      grants,
    });
    expect(result.client).toBeNull();
    expect(result.organizations).toEqual([{ id: 'organization_1', name: 'T' }]);
    expect(result.activeOrganizationId).toBe('organization_1');
  });

  it('rethrows non-404 client lookup errors', async () => {
    getOAuthClientPublic.mockRejectedValueOnce(
      new APIError('INTERNAL_SERVER_ERROR', { message: 'db' })
    );
    await expect(
      loadOAuthConsentContext({
        userId: 'user_1',
        organizationId: 'organization_1',
        clientId: 'c1',
        scope: '',
        headers: new Headers(),
        grants,
      })
    ).rejects.toBeInstanceOf(APIError);
  });
});

describe('loadOAuthConsentContext spend cap', () => {
  it('asks for a cap only for models:invoke, with the caps this client already has', async () => {
    getOAuthClientPublic.mockResolvedValue(client);
    grants.listStandings.mockResolvedValueOnce([
      {
        oauthClientId: 'c1',
        organizationId: 'organization_1',
        monthlyCapMicros: 7_000_000,
        spentMicros: 0,
        heldMicros: 0,
        remainingMicros: 7_000_000,
      },
      {
        oauthClientId: 'other',
        organizationId: 'organization_1',
        monthlyCapMicros: 9_000_000,
        spentMicros: 0,
        heldMicros: 0,
        remainingMicros: 9_000_000,
      },
    ]);
    const invoking = await loadOAuthConsentContext({
      userId: 'user_1',
      organizationId: 'organization_1',
      clientId: 'c1',
      scope: 'openid models:invoke',
      headers: new Headers(),
      grants,
    });
    expect(invoking.needsSpendCap).toBe(true);
    expect(invoking.currentCaps).toEqual({ organization_1: 7_000_000 });

    const reading = await loadOAuthConsentContext({
      userId: 'user_1',
      organizationId: 'organization_1',
      clientId: 'c1',
      scope: 'openid sequences:read',
      headers: new Headers(),
      grants,
    });
    expect(reading.needsSpendCap).toBe(false);
    expect(reading.currentCaps).toEqual({});
  });
});

describe('performAuthorizedAppRevoke', () => {
  it("revokes the consent organization's spend grant before anything else", async () => {
    const order: string[] = [];
    getOAuthConsents.mockResolvedValueOnce([
      { id: 'consent_1', clientId: 'c1', referenceId: 'organization_1' },
    ]);
    grants.revoke.mockImplementationOnce(async () => {
      order.push('grant');
    });
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
      grants,
    });
    expect(order).toEqual(['grant', 'revoke', 'delete']);
    expect(grants.revoke).toHaveBeenCalledWith({
      oauthClientId: 'c1',
      organizationId: 'organization_1',
    });
  });

  it("revokes every organization's grant when the consent row is gone", async () => {
    getOAuthConsents.mockResolvedValueOnce([]);
    await performAuthorizedAppRevoke({
      userId: 'user_1',
      consentId: 'consent_1',
      clientId: 'c1',
      headers: new Headers(),
      grants,
    });
    expect(grants.revoke).toHaveBeenCalledWith({
      oauthClientId: 'c1',
      organizationId: null,
    });
  });

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
      grants,
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
      grants,
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

  it('reads location from a thrown Better Auth FOUND error', () => {
    expect(
      consentRedirectUrl(
        new APIError('FOUND', undefined, {
          location: 'http://127.0.0.1:8765/cb?code=9',
        })
      )
    ).toBe('http://127.0.0.1:8765/cb?code=9');
  });
});

describe('decideOAuthConsent', () => {
  const signedQuery =
    '?client_id=c1&sig=deadbeef&exp=1700000000&resource=https://x/api/v1';
  const origin = 'https://pr.example';

  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('accepts redirect_uri when the client does not set url', async () => {
    let picked: string | undefined;
    authHandler.mockImplementationOnce(async () => {
      picked = consentOrganization.getStore();
      return jsonRes({ redirect_uri: 'http://127.0.0.1:8765/cb?code=2' });
    });
    const result = await decideOAuthConsent({
      userId: 'user_1',
      organizationId: 'organization_1',
      accept: true,
      oauthQuery: 'client_id=c1',
      headers: new Headers({ origin }),
      grants,
    });
    expect(result.url).toBe('http://127.0.0.1:8765/cb?code=2');
    // The grant is stamped with the picked organization, not the active one.
    expect(picked).toBe('organization_1');
    expect(getUserOrganizationMembership).toHaveBeenCalledWith(
      'user_1',
      'organization_1'
    );
  });

  it('unpacks a packed q before calling the provider', async () => {
    const { packOAuthQuery } =
      await import('@/platform/auth/oauth-query-snapshot');
    authHandler.mockResolvedValueOnce(
      jsonRes({ url: 'http://127.0.0.1:8765/cb?code=3' })
    );
    await decideOAuthConsent({
      userId: 'user_1',
      organizationId: 'organization_1',
      accept: true,
      oauthQuery: `?q=${packOAuthQuery(signedQuery)}`,
      headers: new Headers({ origin }),
      grants,
    });
    const req = authHandler.mock.calls[0]?.[0];
    expect(req).toBeInstanceOf(Request);
    expect(req.url).toBe(`${origin}/api/auth/oauth2/consent`);
    expect(req.method).toBe('POST');
    expect(await req.json()).toEqual({
      accept: true,
      oauth_query: signedQuery.slice(1),
    });
  });

  it('posts JSON with the session cookie and CORS fetch hints', async () => {
    authHandler.mockResolvedValueOnce(
      jsonRes({ url: 'http://127.0.0.1:8765/cb?code=4' })
    );
    await decideOAuthConsent({
      userId: 'user_1',
      organizationId: 'organization_1',
      accept: true,
      oauthQuery: 'client_id=c1',
      headers: new Headers({
        origin,
        cookie: 'better-auth.session_token=abc',
        accept: 'text/html',
      }),
      grants,
    });
    const req = authHandler.mock.calls[0]?.[0];
    expect(req).toBeInstanceOf(Request);
    expect(req.headers.get('Accept')).toBe('application/json');
    expect(req.headers.get('Sec-Fetch-Mode')).toBe('cors');
    expect(req.headers.get('Cookie')).toBe('better-auth.session_token=abc');
    expect(req.headers.get('Origin')).toBe(origin);
  });

  it('uses Location from a 302', async () => {
    authHandler.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://127.0.0.1:8765/cb?code=5' },
      })
    );
    const result = await decideOAuthConsent({
      userId: 'user_1',
      organizationId: 'organization_1',
      accept: true,
      oauthQuery: 'client_id=c1',
      headers: new Headers({ origin }),
      grants,
    });
    expect(result.url).toBe('http://127.0.0.1:8765/cb?code=5');
  });

  it('rewrites RFC 9207 iss on the callback to the loopback request origin', async () => {
    authHandler.mockResolvedValueOnce(
      jsonRes({
        url: 'http://127.0.0.1:53100/callback?code=6&iss=http://localhost:3000',
      })
    );
    const result = await decideOAuthConsent({
      userId: 'user_1',
      organizationId: 'organization_1',
      accept: true,
      oauthQuery: 'client_id=c1',
      headers: new Headers({ origin: 'http://localhost:3002' }),
      grants,
    });
    expect(new URL(result.url).searchParams.get('iss')).toBe(
      'http://localhost:3002'
    );
    expect(new URL(result.url).searchParams.get('code')).toBe('6');
  });

  it('strips a leading ? and returns the provider redirect', async () => {
    authHandler.mockResolvedValueOnce(
      jsonRes({ url: 'http://127.0.0.1:8765/cb?code=1' })
    );
    const result = await decideOAuthConsent({
      userId: 'user_1',
      organizationId: 'organization_1',
      accept: true,
      oauthQuery: signedQuery,
      headers: new Headers({ origin }),
      grants,
    });
    expect(result.url).toBe('http://127.0.0.1:8765/cb?code=1');
  });

  it('surfaces a provider error_description as ValidationError', async () => {
    authHandler.mockResolvedValueOnce(
      jsonRes(
        {
          error: 'invalid_request',
          error_description: 'missing oauth query',
        },
        400
      )
    );
    await expect(
      decideOAuthConsent({
        userId: 'user_1',
        organizationId: 'organization_1',
        accept: true,
        oauthQuery: 'client_id=c1',
        headers: new Headers({ origin }),
        grants,
      })
    ).rejects.toMatchObject({
      name: ValidationError.name,
      message: 'missing oauth query',
    });
  });

  describe('a request for models:invoke', () => {
    const invokeQuery = 'client_id=c1&scope=openid%20models%3Ainvoke';

    it('is refused without a valid cap, before the provider sees it', async () => {
      for (const monthlyCapMicros of [undefined, null, 0, 1_500_000, 5e12]) {
        await expect(
          decideOAuthConsent({
            userId: 'user_1',
            organizationId: 'organization_1',
            accept: true,
            oauthQuery: invokeQuery,
            monthlyCapMicros,
            headers: new Headers({ origin }),
            grants,
          })
        ).rejects.toBeInstanceOf(ValidationError);
      }
      expect(authHandler).not.toHaveBeenCalled();
      expect(grants.setCap).not.toHaveBeenCalled();
    });

    it('writes the grant for the picked organization once the provider consents', async () => {
      const order: string[] = [];
      authHandler.mockImplementationOnce(async () => {
        order.push('consent');
        return jsonRes({ url: 'http://127.0.0.1:8765/cb?code=7' });
      });
      grants.setCap.mockImplementationOnce(async () => {
        order.push('grant');
        return true;
      });
      await decideOAuthConsent({
        userId: 'user_1',
        organizationId: 'organization_1',
        accept: true,
        oauthQuery: invokeQuery,
        monthlyCapMicros: 25_000_000,
        headers: new Headers({ origin }),
        grants,
      });
      expect(order).toEqual(['consent', 'grant']);
      expect(grants.setCap).toHaveBeenCalledWith({
        oauthClientId: 'c1',
        organizationId: 'organization_1',
        monthlyCapMicros: 25_000_000,
      });
    });

    it('writes no grant on a denial, and needs no cap to deny', async () => {
      authHandler.mockResolvedValueOnce(
        jsonRes({ url: 'http://127.0.0.1:8765/cb?error=access_denied' })
      );
      await decideOAuthConsent({
        userId: 'user_1',
        organizationId: 'organization_1',
        accept: false,
        oauthQuery: invokeQuery,
        headers: new Headers({ origin }),
        grants,
      });
      expect(grants.setCap).not.toHaveBeenCalled();
    });

    it('writes no grant when the provider refuses the consent', async () => {
      authHandler.mockResolvedValueOnce(
        jsonRes({ error: 'invalid_request', error_description: 'nope' }, 400)
      );
      await expect(
        decideOAuthConsent({
          userId: 'user_1',
          organizationId: 'organization_1',
          accept: true,
          oauthQuery: invokeQuery,
          monthlyCapMicros: 25_000_000,
          headers: new Headers({ origin }),
          grants,
        })
      ).rejects.toBeInstanceOf(ValidationError);
      expect(grants.setCap).not.toHaveBeenCalled();
    });

    it('needs no cap when the request does not ask for models:invoke', async () => {
      authHandler.mockResolvedValueOnce(
        jsonRes({ url: 'http://127.0.0.1:8765/cb?code=8' })
      );
      await decideOAuthConsent({
        userId: 'user_1',
        organizationId: 'organization_1',
        accept: true,
        oauthQuery: 'client_id=c1&scope=openid',
        headers: new Headers({ origin }),
        grants,
      });
      expect(grants.setCap).not.toHaveBeenCalled();
    });
  });
});

describe('setAuthorizedAppCap', () => {
  it("sets the cap on the consent's client and organization", async () => {
    getOAuthConsents.mockResolvedValueOnce([
      {
        id: 'consent_1',
        clientId: 'c1',
        referenceId: 'organization_1',
        scopes: ['openid', 'models:invoke'],
      },
    ]);
    await setAuthorizedAppCap({
      consentId: 'consent_1',
      monthlyCapMicros: 40_000_000,
      headers: new Headers(),
      grants,
    });
    expect(grants.setCap).toHaveBeenCalledWith({
      oauthClientId: 'c1',
      organizationId: 'organization_1',
      monthlyCapMicros: 40_000_000,
    });
  });

  it('refuses a consent without models:invoke, an unknown consent and a bad cap', async () => {
    getOAuthConsents.mockResolvedValue([
      {
        id: 'consent_1',
        clientId: 'c1',
        referenceId: 'organization_1',
        scopes: ['openid'],
      },
    ]);
    for (const input of [
      { consentId: 'consent_1', monthlyCapMicros: 40_000_000 },
      { consentId: 'missing', monthlyCapMicros: 40_000_000 },
      { consentId: 'consent_1', monthlyCapMicros: 0 },
    ]) {
      await expect(
        setAuthorizedAppCap({ ...input, headers: new Headers(), grants })
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(grants.setCap).not.toHaveBeenCalled();
  });
});
