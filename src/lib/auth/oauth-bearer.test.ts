/**
 * OAuth bearer verification (#1456): tokens are verified locally against the
 * JWKS the `jwt` plugin keeps in D1, read through `auth.api.getJwks()`.
 */

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ISSUER = 'https://openstory.test';
const API_AUDIENCE = `${ISSUER}/api/v1`;

const keys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
const publicJwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'k1',
  alg: 'EdDSA',
};
const rogue = await generateKeyPair('EdDSA', { crv: 'Ed25519' });

const getJwks = vi.fn(async () => ({ keys: [publicJwk] }));

vi.doMock('@/lib/auth/config', () => ({
  getAuth: () => ({ api: { getJwks } }),
  PUBLIC_API_KEY_PREFIX: 'osk_',
}));
vi.doMock('@/lib/auth/oauth-provider', () => ({
  resolveOAuthIssuer: () => ISSUER,
}));

const {
  bearerChallengeHeaders,
  isOAuthResourcePath,
  looksLikeOAuthAccessToken,
  readBearerToken,
  resetOAuthJwksCache,
  verifyOAuthAccessToken,
} = await import('./oauth-bearer');

async function mint(
  claims: Record<string, unknown>,
  opts: {
    kid?: string;
    key?: CryptoKey;
    expiresIn?: string;
    audience?: string;
    issuer?: string;
  } = {}
) {
  return new SignJWT({
    scope: 'sequences:read generate',
    client_id: 'c1',
    ...claims,
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: opts.kid ?? 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setSubject('user_1')
    .setAudience(opts.audience ?? API_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '1h')
    .setJti('jti_1')
    .sign(opts.key ?? keys.privateKey);
}

beforeEach(() => {
  resetOAuthJwksCache();
  getJwks.mockClear();
});

describe('readBearerToken / looksLikeOAuthAccessToken', () => {
  it('reads the bearer value and routes keys away from JWT verification', () => {
    const req = new Request('https://x', {
      headers: { authorization: 'Bearer osk_abc' },
    });
    expect(readBearerToken(req)).toBe('osk_abc');
    expect(looksLikeOAuthAccessToken('osk_abc')).toBe(false);
    expect(looksLikeOAuthAccessToken('a.b.c')).toBe(true);
    expect(looksLikeOAuthAccessToken('nope')).toBe(false);
    expect(readBearerToken(new Request('https://x'))).toBeNull();
  });
});

describe('isOAuthResourcePath', () => {
  it('matches /api/v1 only, not internal routes', () => {
    expect(isOAuthResourcePath('/api/v1')).toBe(true);
    expect(isOAuthResourcePath('/api/v1/sequences')).toBe(true);
    expect(isOAuthResourcePath('/api/storage/upload')).toBe(false);
    expect(isOAuthResourcePath('/api/realtime')).toBe(false);
    expect(isOAuthResourcePath('/api/v10')).toBe(false);
  });
});

describe('verifyOAuthAccessToken', () => {
  it('accepts a token signed by the current key for the right audience', async () => {
    const token = await mint({ team_id: 'team_1' });
    const verified = await verifyOAuthAccessToken(token, API_AUDIENCE);
    expect(verified).toEqual({
      userId: 'user_1',
      teamId: 'team_1',
      clientId: 'c1',
      scopes: ['sequences:read', 'generate'],
      audience: [API_AUDIENCE],
      tokenId: 'jti_1',
    });
  });

  it('rejects the wrong audience', async () => {
    expect(
      await verifyOAuthAccessToken(
        await mint({}, { audience: `${ISSUER}/mcp` }),
        API_AUDIENCE
      )
    ).toBeNull();
  });

  it('rejects an expired token', async () => {
    expect(
      await verifyOAuthAccessToken(
        await mint({}, { expiresIn: '-1s' }),
        API_AUDIENCE
      )
    ).toBeNull();
  });

  it('rejects a rogue key', async () => {
    expect(
      await verifyOAuthAccessToken(
        await mint({}, { key: rogue.privateKey }),
        API_AUDIENCE
      )
    ).toBeNull();
  });

  it('rejects a token with the wrong issuer', async () => {
    expect(
      await verifyOAuthAccessToken(
        await mint({}, { issuer: 'https://evil.example' }),
        API_AUDIENCE
      )
    ).toBeNull();
  });

  it('throws when JWKS cannot be loaded', async () => {
    getJwks.mockRejectedValueOnce(new Error('D1 down'));
    await expect(
      verifyOAuthAccessToken(await mint({}), API_AUDIENCE)
    ).rejects.toThrow('D1 down');
  });

  it('refreshes the JWKS once for an unknown kid, then gives up', async () => {
    const token = await mint({}, { kid: 'k2' });
    expect(await verifyOAuthAccessToken(token, API_AUDIENCE)).toBeNull();
    expect(getJwks).toHaveBeenCalledTimes(2);
  });

  it('caches the JWKS across verifications', async () => {
    await verifyOAuthAccessToken(await mint({}), API_AUDIENCE);
    await verifyOAuthAccessToken(await mint({}), API_AUDIENCE);
    expect(getJwks).toHaveBeenCalledTimes(1);
  });

  it('tolerates a missing team claim', async () => {
    const verified = await verifyOAuthAccessToken(await mint({}), API_AUDIENCE);
    expect(verified?.teamId).toBeNull();
  });
});

describe('bearerChallengeHeaders', () => {
  it('formats an RFC 6750 challenge with the RFC 9728 pointer', () => {
    const headers = new Headers(
      bearerChallengeHeaders({
        resourceMetadataUrl: `${ISSUER}/.well-known/oauth-protected-resource/api/v1`,
        error: 'insufficient_scope',
        scope: ['generate'],
      })
    );
    expect(headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/v1", error="insufficient_scope", scope="generate"`
    );
  });
});
