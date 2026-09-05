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
 * (verified in `src/lib/auth/oauth-bearer.ts`).
 *
 * Wiring beyond this file:
 * - `src/routes/[.]well-known/$.ts` forwards root `/.well-known/*` requests to
 *   the auth handler. Better Auth is mounted at `/api/auth`, so the plugins'
 *   `onRequest` discovery hooks never see root requests otherwise.
 * - `src/routes/oauth/login.ts` turns the plugin's signed login redirect into a
 *   plain `/login?redirectTo=…`, so the auth form needs no OAuth awareness.
 * - `src/routes/oauth/consent-start.ts` packs the signed consent query so
 *   TanStack cannot collapse repeated `ba_param`, then 302s to
 *   `src/routes/_app/oauth/consent.tsx` + `src/functions/oauth-consent.ts`.
 * - At consent the grant is stamped with the user's default team
 *   (`consentReferenceId` → `resolveUserTeam`); there is no picker yet.
 *   `/api/v1` uses `team_id` when present, otherwise the same default-team
 *   lookup as an `osk_` key.
 */

import { getEnv } from '#env';
import { OAUTH_CONSENT_START_PATH } from '@/shared/auth/oauth-query-snapshot';
import { OAUTH_API_SCOPES, OAUTH_SCOPES } from '@/lib/auth/oauth-scopes';
import { resolveUserTeam } from '@/lib/db/scoped';
import { getLogger } from '@/shared/observability/logger';
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

export function resolveOAuthIssuer(): string {
  return pickOAuthIssuer(getEnv().VITE_APP_URL, import.meta.env.DEV);
}

/** RFC 8707 resource identifier for the MCP endpoint (#1457). */
export function mcpResourceIdentifier(issuer = resolveOAuthIssuer()): string {
  return `${issuer}/mcp`;
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
 * elimination and shipped `@/lib/db/scoped` and `better-auth/plugins` to the
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
 * The Better Auth plugins that make OpenStory an authorization server. Order
 * matters: `mcp()` looks up the `jwt()` plugin for signing keys and the
 * issuer.
 */
export function createOAuthProviderPlugins() {
  const issuer = resolveOAuthIssuer();
  const apiResource = apiResourceIdentifier(issuer);

  return [
    jwt({
      jwt: { issuer },
      // Do not attach `set-auth-jwt` on getSession — that header is a
      // session JWT from the same JWKS, not an OAuth access token.
      disableSettingJwtHeader: true,
    }),
    mcp({
      resource: mcpResourceIdentifier(issuer),
      loginPage: OAUTH_LOGIN_PATH,
      consentPage: OAUTH_CONSENT_START_PATH,
      scopes: [...OAUTH_SCOPES],
      resources: [
        {
          identifier: apiResource,
          name: 'OpenStory API',
          allowedScopes: [...OAUTH_API_SCOPES],
        },
      ],
      // Dynamically registered clients (hosted MCP clients, forks) may request
      // tokens for the API as well as the MCP resource, which the plugin
      // appends on its own.
      clientRegistrationDefaultResources: [apiResource],
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
