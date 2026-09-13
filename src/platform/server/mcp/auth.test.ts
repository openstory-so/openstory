import { APIError } from 'better-auth/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const verifyOAuthAccessToken = vi.fn();
const getSession = vi.fn();
const findUserById = vi.fn();
const resolveUserTeam = vi.fn();
const getUserTeamMembership = vi.fn();
const createScopedDb = vi.fn((teamId: string, userId: string) => ({
  teamId,
  userId,
}));
const loadComplianceState = vi.fn();

vi.doMock('#env', () => ({
  getEnv: () => ({ VITE_APP_URL: 'https://openstory.test' }),
}));
vi.doMock('@/platform/server/auth/oauth-bearer', async () => {
  const actual = await vi.importActual<
    typeof import('@/platform/server/auth/oauth-bearer')
  >('@/platform/server/auth/oauth-bearer');
  return { ...actual, verifyOAuthAccessToken };
});
vi.doMock('@/platform/server/auth/config', () => ({
  getAuth: () => ({
    api: { getSession },
    $context: Promise.resolve({ internalAdapter: { findUserById } }),
  }),
}));
vi.doMock('@/platform/server/db/scoped', () => ({
  resolveUserTeam,
  getUserTeamMembership,
  createScopedDb,
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  loadComplianceState,
}));
vi.doMock('@/platform/server/compliance/enforcement', () => ({
  restrictionNotice: () => 'restricted',
}));

const { authenticateMcpRequest } = await import('./auth');

const jwt = 'aaa.bbb.ccc';
const user = { id: 'user_1', email: 'ada@example.com', name: 'Ada' };
const team = { teamId: 'team_1', teamName: 'Ada', role: 'owner' };
const oauth = {
  userId: 'user_1',
  teamId: 'team_1',
  clientId: 'c1',
  scopes: ['sequences:read'],
  audience: ['https://openstory.test/mcp'],
  tokenId: 'jti_1',
};

function asResponse(value: unknown): Response {
  if (!(value instanceof Response)) {
    throw new Error(`expected Response, got ${String(value)}`);
  }
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadComplianceState.mockResolvedValue({
    enforcement: { canAccess: true, canWrite: true },
  });
  createScopedDb.mockImplementation((teamId: string, userId: string) => ({
    teamId,
    userId,
  }));
  resolveUserTeam.mockResolvedValue(team);
  getUserTeamMembership.mockResolvedValue(team);
});

describe('authenticateMcpRequest', () => {
  it('returns JSON-RPC 401 with MCP resource_metadata when unauthenticated', async () => {
    getSession.mockResolvedValueOnce(null);
    const res = asResponse(
      await authenticateMcpRequest(new Request('https://openstory.test/mcp'))
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://openstory.test/.well-known/oauth-protected-resource/mcp"'
    );
    const body = z
      .object({ jsonrpc: z.literal('2.0'), id: z.null() })
      .parse(await res.json());
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
  });

  it('resolves an osk_ key through getSession and the default team', async () => {
    getSession.mockResolvedValueOnce({ user });
    const ctx = await authenticateMcpRequest(
      new Request('https://openstory.test/mcp', {
        headers: { authorization: 'Bearer osk_secretvalueXXXX' },
      })
    );
    expect(ctx).not.toBeInstanceOf(Response);
    if (ctx instanceof Response) return;
    expect(ctx.kind).toBe('api_key');
    expect(ctx.user.id).toBe('user_1');
    expect(ctx.teamId).toBe('team_1');
    expect(ctx.keyHint).toBe('osk_…XXXX');
    expect(verifyOAuthAccessToken).not.toHaveBeenCalled();
    expect(createScopedDb).toHaveBeenCalledWith('team_1', 'user_1');
  });

  it('verifies a JWT against the MCP audience and uses team_id', async () => {
    verifyOAuthAccessToken.mockResolvedValueOnce(oauth);
    findUserById.mockResolvedValueOnce(user);
    const ctx = await authenticateMcpRequest(
      new Request('https://openstory.test/mcp', {
        headers: { authorization: `Bearer ${jwt}` },
      })
    );
    expect(ctx).not.toBeInstanceOf(Response);
    if (ctx instanceof Response) return;
    expect(ctx.kind).toBe('oauth');
    expect(ctx.teamId).toBe('team_1');
    expect(ctx.keyHint).toBe('jwt:jti_1');
    expect(verifyOAuthAccessToken).toHaveBeenCalledWith(
      jwt,
      ['https://openstory.test/mcp'],
      ['https://openstory.test']
    );
    expect(getUserTeamMembership).toHaveBeenCalledWith('user_1', 'team_1');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('401s invalid_token for a wrong-audience JWT', async () => {
    verifyOAuthAccessToken.mockResolvedValueOnce(null);
    const res = asResponse(
      await authenticateMcpRequest(
        new Request('https://openstory.test/mcp', {
          headers: { authorization: `Bearer ${jwt}` },
        })
      )
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
  });

  it('401s a revoked or unknown osk_ key', async () => {
    getSession.mockRejectedValueOnce(new APIError('UNAUTHORIZED', {}));
    const res = asResponse(
      await authenticateMcpRequest(
        new Request('https://openstory.test/mcp', {
          headers: { authorization: 'Bearer osk_revoked' },
        })
      )
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
  });

  it('429s when the api-key limiter trips', async () => {
    const error = new APIError('TOO_MANY_REQUESTS', {
      details: { tryAgainIn: 1500 },
    });
    getSession.mockRejectedValueOnce(error);
    const res = asResponse(
      await authenticateMcpRequest(
        new Request('https://openstory.test/mcp', {
          headers: { authorization: 'Bearer osk_fast' },
        })
      )
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('2');
  });

  it('403s when the account cannot access the service', async () => {
    getSession.mockResolvedValueOnce({ user });
    loadComplianceState.mockResolvedValueOnce({
      enforcement: { canAccess: false, canWrite: false },
    });
    const res = asResponse(
      await authenticateMcpRequest(
        new Request('https://openstory.test/mcp', {
          headers: { authorization: 'Bearer osk_blocked' },
        })
      )
    );
    expect(res.status).toBe(403);
  });
});
