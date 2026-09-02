import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyOAuthAccessToken = vi.fn();
const getSession = vi.fn();
const findUserById = vi.fn();

vi.doMock('@/lib/auth/oauth-bearer', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/auth/oauth-bearer')
  >('@/lib/auth/oauth-bearer');
  return { ...actual, verifyOAuthAccessToken };
});

vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({
    api: { getSession },
    $context: Promise.resolve({ internalAdapter: { findUserById } }),
  }),
}));

vi.doMock('@/lib/auth/oauth-provider', () => ({
  apiResourceIdentifier: () => 'https://openstory.test/api/v1',
  resolveOAuthIssuer: () => 'https://openstory.test',
}));

const { resolveRequestPrincipal } = await import('./middleware');

const jwt = 'aaa.bbb.ccc';
const user = { id: 'user_1', email: 'ada@example.com', name: 'Ada' };
const oauth = {
  userId: 'user_1',
  teamId: 'team_1',
  clientId: 'c1',
  scopes: ['sequences:read'],
  audience: ['https://openstory.test/api/v1'],
  tokenId: 'jti_1',
};

beforeEach(() => {
  verifyOAuthAccessToken.mockReset();
  getSession.mockReset();
  findUserById.mockReset();
});

function asThrownResponse(error: unknown): Response {
  if (!(error instanceof Response)) {
    throw new Error(`expected Response, got ${String(error)}`);
  }
  return error;
}

describe('resolveRequestPrincipal OAuth gate', () => {
  it('verifies a JWT on /api/v1 and returns an OAuth principal', async () => {
    verifyOAuthAccessToken.mockResolvedValueOnce(oauth);
    findUserById.mockResolvedValueOnce(user);
    const principal = await resolveRequestPrincipal(
      new Request('https://x/api/v1/sequences', {
        headers: { authorization: `Bearer ${jwt}` },
      })
    );
    expect(principal?.oauth).toEqual(oauth);
    expect(principal?.session).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('does not verify a JWT on /api/storage — falls through to the session', async () => {
    getSession.mockResolvedValueOnce(null);
    const principal = await resolveRequestPrincipal(
      new Request('https://x/api/storage/upload', {
        method: 'PUT',
        headers: { authorization: `Bearer ${jwt}` },
      })
    );
    expect(principal).toBeNull();
    expect(verifyOAuthAccessToken).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalled();
  });

  it('401s invalid_token when verification returns null on /api/v1', async () => {
    verifyOAuthAccessToken.mockResolvedValueOnce(null);
    await expect(
      resolveRequestPrincipal(
        new Request('https://x/api/v1/sequences', {
          headers: { authorization: `Bearer ${jwt}` },
        })
      )
    ).rejects.toSatisfy((error: unknown) => {
      const res = asThrownResponse(error);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
      return true;
    });
  });

  it('500s when JWKS load throws', async () => {
    verifyOAuthAccessToken.mockRejectedValueOnce(new Error('D1 down'));
    await expect(
      resolveRequestPrincipal(
        new Request('https://x/api/v1/sequences', {
          headers: { authorization: `Bearer ${jwt}` },
        })
      )
    ).rejects.toSatisfy((error: unknown) => {
      expect(asThrownResponse(error).status).toBe(500);
      return true;
    });
  });

  it('401s invalid_token when the subject no longer exists', async () => {
    verifyOAuthAccessToken.mockResolvedValueOnce(oauth);
    findUserById.mockResolvedValueOnce(null);
    await expect(
      resolveRequestPrincipal(
        new Request('https://x/api/v1/sequences', {
          headers: { authorization: `Bearer ${jwt}` },
        })
      )
    ).rejects.toSatisfy((error: unknown) => {
      const res = asThrownResponse(error);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
      return true;
    });
  });
});
