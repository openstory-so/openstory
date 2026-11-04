/**
 * Dual auth for `/mcp` (#1457): OAuth bearer JWT (audience `…/mcp`) or an
 * `osk_` API key.
 *
 * We do not call `requireMcpAuth` from `@better-auth/mcp`. That helper
 * HTTP-fetches `/jwks` and needs a resolvable Better Auth `baseURL`; this
 * Worker verifies locally against D1 JWKS (same as `/api/v1`) and also
 * accepts `osk_` keys. The JSON-RPC 401 + RFC 9728 `WWW-Authenticate`
 * envelope matches `requireMcpAuth` so hosted clients still start OAuth.
 */

import type { Session, User } from '@/platform/server/auth/config';
import { getAuth } from '@/platform/server/auth/config';
import {
  looksLikeOAuthAccessToken,
  readBearerToken,
  verifyOAuthAccessToken,
  type OAuthAccessToken,
} from '@/platform/server/auth/oauth-bearer';
import {
  isLoopbackOrigin,
  mcpResourceIdentifier,
  mcpResourceIdentifierForRequest,
  resolveOAuthIssuer,
} from '@/platform/server/auth/oauth-provider';
import { PUBLIC_API_KEY_PREFIX } from '@/platform/server/auth/public-api-key';
import { restrictionNotice } from '@/platform/server/compliance/enforcement';
import { loadComplianceState } from '@/platform/server/compliance/generation-gate';
import {
  getUserById,
  getUserOrganizationMembership,
} from '@/platform/server/db/scoped';
import { sessionOrganizationId } from '@/platform/server/auth/request-principal';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { APIError } from 'better-auth/api';
import { mcpJsonRpcError, mcpUnauthorized } from './json-rpc';

const logger = getLogger(['openstory', 'mcp', 'auth']);

type McpAuthKind = 'oauth' | 'api_key';

/** Identity tools (whoami) need; extra on AuthInfo carries this, not secrets. */
export type McpCallerIdentity = {
  user: User;
  organizationId: string;
  organizationName: string;
};

export type McpAuthContext = McpCallerIdentity & {
  session: Session | null;
  oauth: OAuthAccessToken | null;
  kind: McpAuthKind;
  /** Never the secret. `osk_…abcd` or `jwt:<jti>`. */
  keyHint: string;
  clientId: string;
  scopes: readonly string[];
};

function keyHintForApiKey(key: string): string {
  const rest = key.startsWith(PUBLIC_API_KEY_PREFIX)
    ? key.slice(PUBLIC_API_KEY_PREFIX.length)
    : key;
  const tail = rest.slice(-4);
  return `${PUBLIC_API_KEY_PREFIX}…${tail}`;
}

function mcpInternalError(): Response {
  return mcpJsonRpcError(
    500,
    'Authentication could not be processed. Please retry.'
  );
}

async function resolveOrganizationContext(
  user: User,
  oauth: OAuthAccessToken | null,
  organizationId: string | null
): Promise<McpAuthContext | Response> {
  const membership = organizationId
    ? await getUserOrganizationMembership(user.id, organizationId)
    : null;

  if (!membership) {
    return mcpJsonRpcError(
      403,
      oauth
        ? 'This token was issued for an organization you no longer belong to. Re-authorize the app.'
        : 'This key is not linked to an organization you belong to.'
    );
  }

  const compliance = await loadComplianceState(
    user.id,
    membership.organizationId
  );
  if (!compliance.enforcement.canAccess) {
    return mcpJsonRpcError(
      403,
      restrictionNotice(compliance.enforcement) ??
        'This account may not use the service'
    );
  }

  const kind: McpAuthKind = oauth ? 'oauth' : 'api_key';
  return {
    user,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    session: null,
    oauth,
    kind,
    keyHint: oauth
      ? `jwt:${oauth.tokenId ?? 'unknown'}`
      : `${PUBLIC_API_KEY_PREFIX}…`,
    clientId: oauth?.clientId ?? kind,
    scopes: oauth?.scopes ?? [],
  };
}

/**
 * Authenticate one MCP request. Returns the caller context, or a ready
 * JSON-RPC error Response (401 / 403 / 429 / 500).
 */
export async function authenticateMcpRequest(
  request: Request
): Promise<McpAuthContext | Response> {
  const auth = getAuth();
  const bearer = readBearerToken(request);

  if (bearer && looksLikeOAuthAccessToken(bearer)) {
    let token: OAuthAccessToken | null;
    try {
      const origin = new URL(request.url).origin;
      const audiences = [
        ...new Set([
          mcpResourceIdentifier(),
          mcpResourceIdentifierForRequest(request),
        ]),
      ];
      const issuers = [
        ...new Set([
          resolveOAuthIssuer(),
          ...(isLoopbackOrigin(origin) ? [origin] : []),
        ]),
      ];
      token = await verifyOAuthAccessToken(bearer, audiences, issuers);
    } catch (error) {
      if (error instanceof Response) return error;
      logger.error('MCP OAuth JWKS load or verify failed: {message}', {
        message: error instanceof Error ? error.message : String(error),
        err: toErrorPayload(error),
      });
      return mcpInternalError();
    }
    if (!token) return mcpUnauthorized({ invalidToken: true, request });

    const user = await getUserById(token.userId);
    if (!user) return mcpUnauthorized({ invalidToken: true, request });

    const ctx = await resolveOrganizationContext(
      user,
      token,
      token.organizationId ?? null
    );
    if (ctx instanceof Response) return ctx;
    return ctx;
  }

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return mcpUnauthorized({ request });
    const ctx = await resolveOrganizationContext(
      session.user,
      null,
      await sessionOrganizationId(session, request.headers)
    );
    if (ctx instanceof Response) return ctx;
    const presented =
      bearer?.startsWith(PUBLIC_API_KEY_PREFIX) === true
        ? keyHintForApiKey(bearer)
        : ctx.keyHint;
    return { ...ctx, session, keyHint: presented };
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 429) {
      const tryAgainInMs = error.body?.details?.tryAgainIn;
      const retryAfter =
        typeof tryAgainInMs === 'number' ? Math.ceil(tryAgainInMs / 1000) : 1;
      return mcpJsonRpcError(
        429,
        'API key rate limit exceeded. Retry shortly.',
        {
          headers: { 'Retry-After': String(retryAfter) },
        }
      );
    }
    if (
      error instanceof APIError &&
      (error.statusCode === 401 || error.statusCode === 403)
    ) {
      return mcpUnauthorized({ invalidToken: true, request });
    }
    logger.error('MCP session resolution failed: {message}', {
      message: error instanceof Error ? error.message : String(error),
      err: toErrorPayload(error),
    });
    return mcpInternalError();
  }
}
