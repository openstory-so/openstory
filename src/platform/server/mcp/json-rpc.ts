/**
 * JSON-RPC error envelopes for `/mcp` (#1457). Matches `@better-auth/mcp`
 * `requireMcpAuth`: HTTP status + `{ jsonrpc: "2.0", error, id: null }`.
 */

import { bearerChallengeHeaders } from '@/platform/server/auth/oauth-bearer';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/server';
import {
  mcpResourceIdentifier,
  mcpResourceIdentifierForRequest,
} from '@/platform/server/auth/oauth-provider';

/** RFC 9728 document at `/.well-known/oauth-protected-resource/mcp`. */
export function mcpResourceMetadataUrl(request?: Request): string {
  const resource = request
    ? mcpResourceIdentifierForRequest(request)
    : mcpResourceIdentifier();
  return getOAuthProtectedResourceMetadataUrl(new URL(resource));
}

export function mcpJsonRpcError(
  status: number,
  message: string,
  options: {
    id?: string | number | null;
    code?: number;
    headers?: HeadersInit;
  } = {}
): Response {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: options.code ?? -32000, message },
      id: options.id ?? null,
    }),
    { status, headers }
  );
}

/** Unauthenticated / invalid-token 401 with the RFC 9728 challenge. */
export function mcpUnauthorized(
  options: {
    invalidToken?: boolean;
    message?: string;
    request?: Request;
  } = {}
): Response {
  const invalidToken = options.invalidToken === true;
  return mcpJsonRpcError(
    401,
    options.message ??
      (invalidToken
        ? 'The access token is invalid, expired, or was not issued for this MCP server.'
        : 'Authentication required'),
    {
      headers: bearerChallengeHeaders({
        resourceMetadataUrl: mcpResourceMetadataUrl(options.request),
        error: invalidToken ? 'invalid_token' : undefined,
      }),
    }
  );
}
