/**
 * `/.well-known/*` — OAuth / OIDC discovery documents (#1456).
 *
 * Better Auth is mounted at `/api/auth`, so its plugins' `onRequest` hooks —
 * which serve RFC 8414 `oauth-authorization-server`, OIDC
 * `openid-configuration`, and RFC 9728 `oauth-protected-resource[/mcp]` —
 * never see a root request unless we forward it. The REST API is a second
 * protected resource the MCP plugin knows nothing about, so its RFC 9728
 * document is built here. Anything else falls through to the auth router's
 * 404.
 */

import { getAuth } from '@/platform/server/auth/config';
import {
  buildApiResourceMetadata,
  buildMcpResourceMetadata,
} from '@/platform/server/auth/oauth-provider';
import { createFileRoute } from '@tanstack/react-router';

const API_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource/api/v1';
const MCP_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';
/** RFC 9728 unsuffixed path — Grok's probe hits this as well as `/mcp`. */
const MCP_RESOURCE_METADATA_ROOT = '/.well-known/oauth-protected-resource';
const AUTH_SERVER_METADATA_PATHS = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/openid-configuration',
]);

function jsonMetadata(doc: unknown, request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(doc), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/**
 * RFC 8414: the `issuer` in the document must equal the origin the client
 * fetched. In `vite dev` the jwt plugin has no pinned issuer, but Better
 * Auth's `getIssuer()` can still be `baseURL` with `/api/auth`. Strip that
 * so Grok does not treat the AS as "no authorization support".
 */
async function withRequestOriginIssuer(
  request: Request,
  response: Response
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return response;
  try {
    const doc: unknown = await response.clone().json();
    if (
      doc === null ||
      typeof doc !== 'object' ||
      !('issuer' in doc) ||
      typeof doc.issuer !== 'string'
    ) {
      return response;
    }
    const origin = new URL(request.url).origin;
    if (doc.issuer === origin) return response;
    return jsonMetadata({ ...doc, issuer: origin }, request);
  } catch {
    return response;
  }
}

const handle = async ({ request }: { request: Request }) => {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  if (pathname === API_RESOURCE_METADATA_PATH) {
    return jsonMetadata(buildApiResourceMetadata(), request);
  }
  if (
    pathname === MCP_RESOURCE_METADATA_PATH ||
    pathname === MCP_RESOURCE_METADATA_ROOT
  ) {
    return jsonMetadata(buildMcpResourceMetadata(request), request);
  }
  const response = await getAuth().handler(request);
  if (AUTH_SERVER_METADATA_PATHS.has(pathname)) {
    return withRequestOriginIssuer(request, response);
  }
  return response;
};

export const Route = createFileRoute('/.well-known/$')({
  server: {
    handlers: {
      GET: handle,
      HEAD: handle,
    },
  },
});
