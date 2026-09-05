/**
 * Resource-server side of the OAuth authorization server (#1456): verify the
 * JWT access tokens it issues when they arrive as `Authorization: Bearer` on
 * a protected resource (`/api/v1/*` today, `/mcp` in #1457).
 *
 * Verification is local — the signing keys are the `jwks` rows the `jwt`
 * plugin manages in D1, read through `auth.api.getJwks()` and cached per
 * isolate — so no request ever fetches our own `/jwks` over HTTP.
 */

import { getAuth } from '@/lib/auth/config';
import { resolveOAuthIssuer } from '@/lib/auth/oauth-provider';
import { PUBLIC_API_KEY_PREFIX } from '@/lib/auth/public-api-key';
import { getLogger } from '@/shared/observability/logger';
import {
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
} from 'jose';
import { z } from 'zod';

const logger = getLogger(['openstory', 'auth', 'oauth-bearer']);

/** Verified, normalised access-token claims. */
export type OAuthAccessToken = {
  userId: string;
  /** The team stamped at consent; null when consent had no `referenceId`. */
  teamId: string | null;
  clientId: string | null;
  scopes: readonly string[];
  audience: readonly string[];
  /** `jti` — for logs, never plaintext token material. */
  tokenId: string | null;
};

const claimsSchema = z.object({
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  scope: z.string().optional(),
  client_id: z.string().optional(),
  team_id: z.string().optional(),
  jti: z.string().optional(),
});

/** `Authorization: Bearer <token>` value, or null. */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Cheap routing predicate: three base64url segments and not an `osk_` key.
 * Not a security check — a positive still has to verify.
 */
export function looksLikeOAuthAccessToken(token: string): boolean {
  if (token.startsWith(PUBLIC_API_KEY_PREFIX)) return false;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/**
 * OAuth bearer JWTs are only a credential on the public API (and `/mcp` in
 * #1457). Internal routes (`/api/storage`, `/api/realtime`) stay cookie/`osk_`.
 */
export function isOAuthResourcePath(pathname: string): boolean {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

/** Signature / claim failures — not JWKS load or D1 errors. */
function isInvalidAccessTokenError(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWKSNoMatchingKey
  );
}

const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache: {
  set: ReturnType<typeof createLocalJWKSet>;
  at: number;
} | null = null;

async function loadJwkSet(force = false) {
  if (!force && jwksCache && Date.now() - jwksCache.at < JWKS_TTL_MS) {
    return jwksCache.set;
  }
  const jwks: JSONWebKeySet = await getAuth().api.getJwks();
  jwksCache = { set: createLocalJWKSet(jwks), at: Date.now() };
  return jwksCache.set;
}

/** Test hook: drop the per-isolate JWKS cache. */
export function resetOAuthJwksCache(): void {
  jwksCache = null;
}

/**
 * Verify a token issued by this server for `audience` (an RFC 8707 resource
 * identifier such as `apiResourceIdentifier()`). Returns null for anything
 * that isn't a valid, unexpired, correctly-audienced token — callers turn
 * that into a 401 challenge.
 *
 * JWKS / D1 failures throw (callers map that to 500). They must not look
 * like `invalid_token` — a key outage would otherwise tell every client to
 * re-authorize. Settings revoke marks `oauth_access_token.revoked`; this
 * verifier does not read that table (stateless JWT, ≤1h).
 */
export async function verifyOAuthAccessToken(
  token: string,
  audience: string
): Promise<OAuthAccessToken | null> {
  const issuer = resolveOAuthIssuer();
  const verify = (set: ReturnType<typeof createLocalJWKSet>) =>
    jwtVerify(token, set, { issuer, audience });

  const verifyWith = async (forceRefresh: boolean) => {
    const set = await loadJwkSet(forceRefresh);
    return (await verify(set)).payload;
  };

  let payload;
  try {
    payload = await verifyWith(false);
  } catch (error) {
    // A key rotated since the cache filled: refresh once and retry.
    if (error instanceof joseErrors.JWKSNoMatchingKey) {
      try {
        payload = await verifyWith(true);
      } catch (retryError) {
        if (!isInvalidAccessTokenError(retryError)) throw retryError;
        logger.warn('OAuth bearer rejected after JWKS refresh', {
          reason: retryError instanceof Error ? retryError.message : 'unknown',
        });
        return null;
      }
    } else if (isInvalidAccessTokenError(error)) {
      logger.warn('OAuth bearer rejected', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return null;
    } else {
      logger.error('OAuth JWKS load or verify failed: {message}', {
        message: error instanceof Error ? error.message : String(error),
        err: error,
      });
      throw error;
    }
  }

  const claims = claimsSchema.safeParse(payload);
  if (!claims.success) {
    logger.warn('OAuth bearer verified but claims are malformed', {
      issues: claims.error.issues.map((issue) => issue.path.join('.')),
    });
    return null;
  }
  const { sub, aud, scope, client_id, team_id, jti } = claims.data;
  return {
    userId: sub,
    teamId: team_id ?? null,
    clientId: client_id ?? null,
    scopes: scope ? scope.split(' ').filter(Boolean) : [],
    audience: Array.isArray(aud) ? aud : [aud],
    tokenId: jti ?? null,
  };
}

/**
 * RFC 6750 challenge headers for a protected resource. `resourceMetadataUrl`
 * is the RFC 9728 document that tells an MCP client where to authorize.
 */
export function bearerChallengeHeaders(input: {
  resourceMetadataUrl: string;
  error?: 'invalid_token' | 'insufficient_scope';
  description?: string;
  scope?: readonly string[];
}): HeadersInit {
  const parts = [`resource_metadata="${input.resourceMetadataUrl}"`];
  if (input.error) parts.push(`error="${input.error}"`);
  if (input.description) {
    parts.push(`error_description="${input.description.replace(/"/g, "'")}"`);
  }
  if (input.scope?.length) parts.push(`scope="${input.scope.join(' ')}"`);
  return { 'WWW-Authenticate': `Bearer ${parts.join(', ')}` };
}
