/**
 * Who is calling a server route (#1456). Lives outside `src/functions/` on
 * purpose: the Start compiler strips `.server()` bodies from the client
 * bundle but keeps plain exports, and this pulls in the Better Auth config
 * (and through it `cloudflare:workers`), which the client build cannot
 * resolve. Server-only — import it from route middleware and API handlers.
 */

import type { Session, User } from './config';
import { getAuth } from './config';
import {
  bearerChallengeHeaders,
  isOAuthResourcePath,
  looksLikeOAuthAccessToken,
  readBearerToken,
  verifyOAuthAccessToken,
  type OAuthAccessToken,
} from './oauth-bearer';
import { apiResourceIdentifier, resolveOAuthIssuer } from './oauth-provider';
import { readPublicApiKeyFromHeaders } from './public-api-key';
import {
  getApiKeyOrganizationId,
  getUserById,
} from '@/platform/server/db/scoped';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { APIError } from 'better-auth/api';

const apiAuthLogger = getLogger(['openstory', 'api', 'auth']);

/**
 * JSON error envelope for request-middleware rejections, matching the
 * `/api/v1` `{ error: { code, message } }` contract. Programmatic callers parse
 * this; a plain-text 401/403 would crash their JSON parser.
 */
export function authErrorResponse(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit
): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

/** RFC 9728 pointer for OAuth bearer challenges on `/api/v1` (#1456). */
export function apiResourceMetadataUrl(): string {
  return `${resolveOAuthIssuer()}/.well-known/oauth-protected-resource/api/v1`;
}

/**
 * Who is calling a `/api/v1` route: a cookie or `osk_` key session, or an
 * OAuth access token (#1456). `organizationId` is the one the caller acts
 * for: the token's, the key's, or the session's active organization.
 */
export type RequestPrincipal = {
  user: User;
  session: Session | null;
  oauth: OAuthAccessToken | null;
  organizationId: string | null;
};

/** The organization a cookie or `osk_` key session acts for. */
export async function sessionOrganizationId(
  session: Session,
  headers: Headers
): Promise<string | null> {
  return readPublicApiKeyFromHeaders(headers)
    ? getApiKeyOrganizationId(session.session.id)
    : (session.session.activeOrganizationId ?? null);
}

/**
 * Resolve the session for a request. The apiKey plugin validates a key header
 * inside `getSession` and *throws* an APIError rather than returning null:
 *   - a 429 (key over its per-key rate limit) is surfaced as a JSON 429 with a
 *     `Retry-After` header (programmatic callers need this);
 *   - a genuine auth rejection (disabled/expired/unknown key → 401/403) is
 *     treated as unauthenticated → null (the caller turns that into a 401);
 *   - anything else (D1 down, auth-backend 5xx, programmer error) is logged and
 *     surfaced as a JSON 500. It must NOT be flattened to a 401 "bad key": that
 *     tells a caller with a perfectly valid key to rotate/abandon it, and hides
 *     the real incident.
 */
export async function resolveRequestPrincipal(
  request: Request
): Promise<RequestPrincipal | null> {
  const auth = getAuth();
  const bearer = readBearerToken(request);
  const pathname = new URL(request.url).pathname;
  if (
    bearer &&
    looksLikeOAuthAccessToken(bearer) &&
    isOAuthResourcePath(pathname)
  ) {
    let token: OAuthAccessToken | null;
    try {
      token = await verifyOAuthAccessToken(bearer, apiResourceIdentifier());
    } catch (error) {
      if (error instanceof Response) throw error;
      throw authErrorResponse(
        500,
        'INTERNAL_ERROR',
        'Authentication could not be processed. Please retry.'
      );
    }
    if (!token) {
      throw authErrorResponse(
        401,
        'UNAUTHORIZED',
        'The OAuth access token is invalid, expired, or was not issued for this API.',
        bearerChallengeHeaders({
          resourceMetadataUrl: apiResourceMetadataUrl(),
          error: 'invalid_token',
        })
      );
    }
    const user = await getUserById(token.userId);
    if (!user) {
      throw authErrorResponse(
        401,
        'UNAUTHORIZED',
        'The OAuth access token is invalid, expired, or was not issued for this API.',
        bearerChallengeHeaders({
          resourceMetadataUrl: apiResourceMetadataUrl(),
          error: 'invalid_token',
        })
      );
    }
    return {
      user,
      session: null,
      oauth: token,
      organizationId: token.organizationId ?? null,
    };
  }
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return null;
    return {
      user: session.user,
      session,
      oauth: null,
      organizationId: await sessionOrganizationId(session, request.headers),
    };
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 429) {
      const tryAgainInMs = error.body?.details?.tryAgainIn;
      const retryAfter =
        typeof tryAgainInMs === 'number' ? Math.ceil(tryAgainInMs / 1000) : 1;
      throw Response.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'API key rate limit exceeded. Retry shortly.',
          },
        },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }
    if (
      error instanceof APIError &&
      (error.statusCode === 401 || error.statusCode === 403)
    ) {
      return null;
    }
    apiAuthLogger.error('session resolution failed: {message}', {
      message: error instanceof Error ? error.message : String(error),
      err: toErrorPayload(error),
    });
    throw authErrorResponse(
      500,
      'INTERNAL_ERROR',
      'Authentication could not be processed. Please retry.'
    );
  }
}
