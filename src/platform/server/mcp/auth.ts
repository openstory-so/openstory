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
  getUserTeamMembership,
  resolveUserTeam,
} from '@/platform/server/db/scoped';
import { getLogger, toErrorPayload } from '@/platform/logger';
import { APIError } from 'better-auth/api';
import { mcpJsonRpcError, mcpUnauthorized } from './json-rpc';

const logger = getLogger(['openstory', 'mcp', 'auth']);

type McpAuthKind = 'oauth' | 'api_key';

/** Identity tools (whoami) need; extra on AuthInfo carries this, not secrets. */
export type McpCallerIdentity = {
  user: User;
  teamId: string;
  teamName: string;
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

async function resolveTeamContext(
  user: User,
  oauth: OAuthAccessToken | null
): Promise<McpAuthContext | Response> {
  const team = oauth?.teamId
    ? await getUserTeamMembership(user.id, oauth.teamId)
    : await resolveUserTeam(user.id);

  if (!team) {
    return mcpJsonRpcError(
      403,
      oauth?.teamId
        ? 'This token was issued for a team you no longer belong to. Re-authorize the app.'
        : 'No team is associated with this account.'
    );
  }

  const compliance = await loadComplianceState(user.id, team.teamId);
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
    teamId: team.teamId,
    teamName: team.teamName,
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

    const { internalAdapter } = await auth.$context;
    const user = await internalAdapter.findUserById(token.userId);
    if (!user) return mcpUnauthorized({ invalidToken: true, request });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- adapter row matches getSession's user
    const ctx = await resolveTeamContext(user as User, token);
    if (ctx instanceof Response) return ctx;
    return ctx;
  }

  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user) return mcpUnauthorized({ request });
    const ctx = await resolveTeamContext(session.user, null);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isMcpCallerIdentity(
  value: unknown
): value is McpCallerIdentity {
  if (!isRecord(value)) return false;
  const user = value.user;
  return (
    isRecord(user) &&
    typeof user.id === 'string' &&
    typeof user.email === 'string' &&
    typeof user.name === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.teamName === 'string'
  );
}
