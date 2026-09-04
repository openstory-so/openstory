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

import { getAuth } from '@/lib/auth/config';
import {
  apiResourceIdentifier,
  resolveOAuthIssuer,
} from '@/lib/auth/oauth-provider';
import { OAUTH_API_SCOPES } from '@/lib/auth/oauth-scopes';
import { createFileRoute } from '@tanstack/react-router';

const API_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource/api/v1';

/** RFC 9728 document for the `/api/v1` resource. */
export function buildApiResourceMetadata() {
  const issuer = resolveOAuthIssuer();
  return {
    resource: apiResourceIdentifier(issuer),
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...OAUTH_API_SCOPES],
    resource_name: 'OpenStory API',
    resource_documentation: `${issuer}/api/v1`,
  };
}

const handle = ({ request }: { request: Request }) => {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  if (pathname === API_RESOURCE_METADATA_PATH) {
    const body = JSON.stringify(buildApiResourceMetadata());
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
