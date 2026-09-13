/**
 * OAuth 2.1 authorization server (#1456).
 *
 * OpenStory issues OAuth access tokens to three kinds of clients:
 *
 * - **Hosted MCP clients** (Claude, Cursor, …). They discover us from a 401 on
 *   the MCP endpoint (RFC 9728 protected-resource metadata → RFC 8414
 *   authorization-server metadata), register themselves with RFC 7591 dynamic
 *   client registration, and send the user to our consent page. Nobody
 *   registers apps by hand.
 * - **Forks and self-hosts** — "login with OpenStory", the OpenRouter pattern
 *   inverted: the fork is the OAuth client, upstream OpenStory is the server,
 *   and the fork holds a refresh token as a team credential.
 * - **Anything else** that can run authorization-code + PKCE against
 *   `/api/auth/oauth2/authorize`. Skills and CLIs keep the device-code login
 *   (#1219), which mints an `osk_` key instead of a token.
 *
 * Built on `@better-auth/mcp`, which is `@better-auth/oauth-provider`
 * preconfigured for MCP: tokens are audience-bound to the MCP resource, newly
 * registered clients are linked to it, and it serves the protected-resource
 * metadata. The REST API is declared as a second resource so the same
 * authorization server issues tokens with `aud = …/api/v1` for `/api/v1/*`
 * (verified in `src/platform/server/auth/oauth-bearer.ts`).
 *
 * Wiring beyond this file:
 * - `src/routes/[.]well-known/$.ts` forwards root `/.well-known/*` requests to
 *   the auth handler. Better Auth is mounted at `/api/auth`, so the plugins'
 *   `onRequest` discovery hooks never see root requests otherwise.
 * - `src/routes/oauth/login.ts` turns the plugin's signed login redirect into a
 *   plain `/login?redirectTo=…`, so the auth form needs no OAuth awareness.
 * - `src/routes/oauth/consent-start.ts` packs the signed consent query so
 *   TanStack cannot collapse repeated `ba_param`, then 302s to
 *   `src/routes/_app/oauth/consent.tsx` + `src/platform/oauth-consent.fn.ts`.
 * - At consent the grant is stamped with the user's default team
 *   (`consentReferenceId` → `resolveUserTeam`); there is no picker yet.
 *   `/api/v1` uses `team_id` when present, otherwise the same default-team
 *   lookup as an `osk_` key.
 */

import { getEnv } from '#env';
import { OAUTH_CONSENT_START_PATH } from '@/platform/auth/oauth-query-snapshot';
import { OAUTH_API_SCOPES, OAUTH_SCOPES } from './oauth-scopes';
import { resolveUserTeam } from '@/platform/server/db/scoped';
import { getLogger } from '@/platform/logger';
import { mcp } from '@better-auth/mcp';
import { jwt } from 'better-auth/plugins';

const logger = getLogger(['openstory', 'auth', 'oauth-provider']);

/** Server route that resumes an interrupted authorize request after login. */
const OAUTH_LOGIN_PATH = '/oauth/login';

const DEV_ISSUER = 'http://localhost:3000';

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/** True when `origin` is an HTTP(S) loopback origin (any port). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * RFC 9207: the authorization-response `iss` must equal the issuer the
 * client discovered. Discovery advertises the request origin on loopback
 * (worktree Vite on :3002 while `VITE_APP_URL` stays :3000), but the jwt
 * plugin still stamps `iss` from the init-time issuer. Rewrite the query
 * param so the callback is not rejected as a mix-up.
 *
 * Production is unchanged: only loopback request origins are rewritten, so
 * a spoofed `Host` cannot retarget a deployed issuer.
 */
export function rewriteAuthorizationIss(
  url: string,
  requestOrigin: string
): string {
  if (!isLoopbackOrigin(requestOrigin)) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('iss')) return url;
    if (parsed.searchParams.get('iss') === requestOrigin) return url;
    parsed.searchParams.set('iss', requestOrigin);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The OAuth issuer: the app origin, no path. RFC 8414 then puts the metadata
 * at `/.well-known/oauth-authorization-server` on the root, which is where MCP
 * clients look first.
 *
 * Deploy-time constant (`VITE_APP_URL`, set per PR preview by the deploy
 * workflow) rather than request-derived: the issuer must be stable across
 * requests, and the OAuth provider validates it at init when there is no
 * request. `@better-auth/mcp` also requires HTTPS or loopback for the MCP
 * resource, so a LAN dev URL falls back to localhost rather than breaking
 * auth entirely.
 */
/**
 * Pick the issuer from a candidate origin. `allowLocalFallback` is true in
 * `vite dev` so a missing / LAN-HTTP `VITE_APP_URL` still boots; production
 * builds must set an HTTPS (or loopback) URL or auth init throws.
 */
export function pickOAuthIssuer(
  raw: string | undefined,
  allowLocalFallback: boolean
): string {
  const candidate = raw?.replace(/\/$/, '') ?? '';
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || isLoopbackHost(url.hostname)) {
        return candidate;
      }
    } catch {
      // invalid URL — fall through
    }
  }
  if (allowLocalFallback) {
    logger.error(
      'OAuth issuer falling back to {fallback}; VITE_APP_URL is {raw}',
      { fallback: DEV_ISSUER, raw: raw ?? '<unset>' }
    );
    return DEV_ISSUER;
  }
  throw new Error(
    `OAuth issuer must be an HTTPS or loopback VITE_APP_URL (got ${raw ?? '<unset>'})`
  );
}

/**
 * Deploy-time issuer from `VITE_APP_URL`, or `null` when it is missing /
 * not a valid HTTPS-or-loopback origin. Callers that have a request should
 * prefer {@link mcpResourceIdentifierForRequest} / the request origin
 * instead of inventing `:3000`.
 */
export function resolveConfiguredOAuthIssuer(): string | null {
  const candidate = getEnv().VITE_APP_URL.replace(/\/$/, '');
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'https:' || isLoopbackHost(url.hostname)) {
      return candidate;
    }
  } catch {
    // invalid URL
  }
  return null;
}

export function resolveOAuthIssuer(): string {
  return pickOAuthIssuer(getEnv().VITE_APP_URL, import.meta.env.DEV);
}

/** RFC 8707 resource identifier for the MCP endpoint (#1457). */
export function mcpResourceIdentifier(issuer = resolveOAuthIssuer()): string {
  return `${issuer}/mcp`;
}

/**
 * Resource identifier Grok/Claude should see for *this* request.
 *
 * Worktrees bind Vite on :3001/:3002 when :3000 is taken, while
 * `VITE_APP_URL` stays `:3000`. Grok requires the RFC 9728 metadata URL
 * in `WWW-Authenticate` to be same-origin as the MCP server, so a
 * challenge that names `:3000` while the client is on `:3002` is
 * discarded as "no authorization support". Loopback requests therefore
 * advertise the request origin; production keeps the deploy-time issuer.
 */
export function mcpResourceIdentifierForRequest(request: Request): string {
  const origin = new URL(request.url).origin;
  if (isLoopbackOrigin(origin)) return `${origin}/mcp`;
  return mcpResourceIdentifier();
}

/**
 * Extra loopback `/mcp` resource identifiers so DCR/authorize on a
 * worktree port (`:3002`) is a configured resource, not `invalid_target`.
 * Production never lists these.
 */
export function loopbackMcpResourceAliases(
  canonical = mcpResourceIdentifier()
): string[] {
  if (!import.meta.env.DEV) return [];
  const ports = [
    3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010,
  ];
  const hosts = ['localhost', '127.0.0.1'];
  return hosts
    .flatMap((host) => ports.map((port) => `http://${host}:${port}/mcp`))
    .filter((identifier) => identifier !== canonical);
}

/** RFC 8707 resource identifier for the public REST API. */
export function apiResourceIdentifier(issuer = resolveOAuthIssuer()): string {
  return `${issuer}/api/v1`;
}

/**
 * RFC 9728 protected-resource document for the `/api/v1` resource, served by
 * `routes/[.]well-known/$.ts`. It lives here, not in the route, because a
 * route file's EXPORTED helpers survive the client build — exporting it there
 * (only its test needed it) kept this module alive past dead-code
 * elimination and shipped `@/platform/server/db/scoped` and `better-auth/plugins` to the
 * browser (#1445).
 */
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

/**
 * RFC 9728 protected-resource document for `/mcp`. Served by
 * `routes/[.]well-known/$.ts` so the `resource` field can follow the
 * request origin on loopback (see `mcpResourceIdentifierForRequest`).
 */
export function buildMcpResourceMetadata(request: Request) {
  const resource = mcpResourceIdentifierForRequest(request);
  const authorizationServer = new URL(resource).origin;
  return {
    resource,
    authorization_servers: [authorizationServer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...OAUTH_API_SCOPES],
    resource_name: 'OpenStory MCP',
    resource_documentation: resource,
  };
}

/**
 * The Better Auth plugins that make OpenStory an authorization server. Order
 * matters: `mcp()` looks up the `jwt()` plugin for signing keys and the
 * issuer.
 */
export function createOAuthProviderPlugins() {
  // Plugin init has no request. `VITE_APP_URL` when set; otherwise a
  // loopback dummy. Live discovery documents (`buildMcpResourceMetadata`,
  // the well-known issuer rewrite) use the request origin so a missing
  // `VITE_APP_URL` or a worktree on :3002 still advertises the URL Grok
  // connected to.
  const issuer = resolveConfiguredOAuthIssuer() ?? DEV_ISSUER;
  const apiResource = apiResourceIdentifier(issuer);
  const mcpResource = mcpResourceIdentifier(issuer);
  const loopbackMcp = loopbackMcpResourceAliases(mcpResource);

  return [
    jwt({
      jwt: { issuer },
      // Do not attach `set-auth-jwt` on getSession — that header is a
      // session JWT from the same JWKS, not an OAuth access token.
      disableSettingJwtHeader: true,
    }),
    mcp({
      resource: mcpResource,
      loginPage: OAUTH_LOGIN_PATH,
      consentPage: OAUTH_CONSENT_START_PATH,
      scopes: [...OAUTH_SCOPES],
      resources: [
        {
          identifier: apiResource,
          name: 'OpenStory API',
          allowedScopes: [...OAUTH_API_SCOPES],
        },
        ...loopbackMcp.map((identifier) => ({
          identifier,
          name: 'OpenStory MCP',
          allowedScopes: [...OAUTH_API_SCOPES],
        })),
      ],
      // Dynamically registered clients (hosted MCP clients, forks) may request
      // tokens for the API as well as the MCP resource, which the plugin
      // appends on its own. Loopback aliases cover worktree ports.
      clientRegistrationDefaultResources: [apiResource, ...loopbackMcp],
      clientRegistrationDefaultScopes: [...OAUTH_SCOPES],
      // RFC 7591, open registration — the MCP spec's expectation. The
      // endpoint is throttled per IP in the auth catch-all route.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Consents (and therefore tokens) are keyed by the team they bill to.
      // `shouldRedirect` is a hook for a future team picker; today the grant
      // goes to the user's default team, exactly like an `osk_` key.
      postLogin: {
        page: OAUTH_CONSENT_START_PATH,
        shouldRedirect: () => false,
        consentReferenceId: async ({ user }) => {
          const team = await resolveUserTeam(user.id);
          return team?.teamId;
        },
      },
      customAccessTokenClaims: ({ referenceId }) =>
        referenceId ? { team_id: referenceId } : {},
    }),
  ];
}
