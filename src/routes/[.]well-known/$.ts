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

const handle = ({ request }: { request: Request }) => {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  if (
    pathname === API_RESOURCE_METADATA_PATH ||
    pathname === MCP_RESOURCE_METADATA_PATH
  ) {
    const doc =
      pathname === MCP_RESOURCE_METADATA_PATH
        ? buildMcpResourceMetadata(request)
        : buildApiResourceMetadata();
    const body = JSON.stringify(doc);
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }
  return getAuth().handler(request);
};

export const Route = createFileRoute('/.well-known/$')({
  server: {
    handlers: {
      GET: handle,
      HEAD: handle,
    },
  },
});
