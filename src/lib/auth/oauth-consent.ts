/**
 * Dashboard side of the OAuth authorization server (#1456): the consent page
 * and the "Authorized apps" list under Settings → Developer. Thin wrappers
 * over the `@better-auth/oauth-provider` endpoints, run under the signed-in
 * user's cookie session (the same shape as `device-auth.ts`).
 *
 * Server-only. The `createServerFn` wrappers live in
 * `src/functions/oauth-consent.ts`; the logic is here because anything a
 * `src/functions/*` module exports besides a server fn survives the Start
 * compiler's client strip and would drag the Better Auth config into the
 * browser bundle (`src/lib/client-server-boundary.test.ts`).
 */

import { getAuth } from '@/lib/auth/config';
import { resolveOAuthQuery } from '@/lib/auth/oauth-query-snapshot';
import { OAUTH_SCOPE_DESCRIPTIONS } from '@/lib/auth/oauth-scopes';
import { resolveUserTeam, revokeOAuthGrantTokens } from '@/lib/db/scoped';
import { ValidationError } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import { APIError } from 'better-auth/api';

const logger = getLogger(['openstory', 'serverFn', 'oauth-consent']);

export type OAuthScopeSummary = { id: string; description: string };

export type OAuthClientSummary = {
  clientId: string;
  name: string;
  /** Client-declared home page — shown, never auto-linked without the origin. */
  uri: string | null;
  logoUri: string | null;
  /** Origin of the first redirect URI: what the user is really approving. */
  redirectOrigin: string | null;
};

export type OAuthConsentContext = {
  client: OAuthClientSummary | null;
  scopes: OAuthScopeSummary[];
  team: { id: string; name: string };
};

export type AuthorizedApp = {
  consentId: string;
  client: OAuthClientSummary;
  scopes: OAuthScopeSummary[];
  createdAt: Date;
  updatedAt: Date;
};

const scopeSummaries = (scope: string): OAuthScopeSummary[] =>
  scope
    .split(' ')
    .filter(Boolean)
    .map((id) => ({
      id,
      description: OAUTH_SCOPE_DESCRIPTIONS[id] ?? id,
    }));

function originOf(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).origin;
  } catch {
    return null;
  }
}

export function toClientSummary(
  client: {
    client_id: string;
    client_name?: string;
    client_uri?: string;
    logo_uri?: string;
    redirect_uris: string[];
  },
  requestedRedirectUri?: string
): OAuthClientSummary {
  const redirectOrigin =
    originOf(requestedRedirectUri) ?? originOf(client.redirect_uris[0]);
  return {
    clientId: client.client_id,
    name: client.client_name?.trim() || redirectOrigin || client.client_id,
    uri: client.client_uri ?? null,
    logoUri: client.logo_uri ?? null,
    redirectOrigin,
  };
}

/**
 * What the consent page renders: who is asking, for what, and which team the
 * grant will bill to. Unknown client ids read as `client: null`.
 */
export async function loadOAuthConsentContext(input: {
  userId: string;
  teamId: string;
  clientId: string;
  scope: string;
  redirectUri?: string;
  headers: Headers;
}): Promise<OAuthConsentContext> {
  const auth = getAuth();
  let client: OAuthClientSummary | null = null;
  try {
    const found = await auth.api.getOAuthClientPublic({
      headers: input.headers,
      query: { client_id: input.clientId },
    });
    client = toClientSummary(found, input.redirectUri);
  } catch (error) {
    if (!(error instanceof APIError)) throw error;
    if (error.statusCode !== 404) throw error;
  }
  const team = await resolveUserTeam(input.userId);
  return {
    client,
    scopes: scopeSummaries(input.scope),
    team: {
      id: team?.teamId ?? input.teamId,
      name: team?.teamName ?? '',
    },
  };
}

const CONSENT_STALE_MESSAGE =
  'This request is no longer valid. Start again from the app.';

/** Provider errors often set `error` / `error_description` and leave `message` empty. */
export function oauthProviderUserMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof APIError) {
    const body = error.body as
      | { error?: string; error_description?: string; message?: string }
      | undefined;
    if (body?.error === 'invalid_signature') return fallback;
    const text = body?.error_description || body?.message;
    if (text?.trim()) return text;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/**
 * Better Auth's consent handler 302s unless the call looks like a CORS fetch
 * that accepts JSON (`sec-fetch-mode: cors` + `Accept: application/json`).
 * Server-fn headers can miss that, so the grant is written and then the
 * redirect is thrown — which we used to map to "no longer valid".
 */
function jsonConsentHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.set('Accept', 'application/json');
  next.set('Sec-Fetch-Mode', 'cors');
  return next;
}

/** `oauth2Consent` OpenAPI says `redirect_uri`; the JS client also uses `url`. */
export function consentRedirectUrl(result: unknown): string | null {
  if (!result) return null;
  if (result instanceof Response) {
    return result.headers.get('Location');
  }
  if (typeof result !== 'object') return null;
  const rec = result as {
    url?: unknown;
    redirect_uri?: unknown;
    headers?: { get?: (name: string) => string | null };
  };
  if (typeof rec.url === 'string' && rec.url.length > 0) return rec.url;
  if (typeof rec.redirect_uri === 'string' && rec.redirect_uri.length > 0) {
    return rec.redirect_uri;
  }
  const location =
    rec.headers?.get?.('Location') ?? rec.headers?.get?.('location');
  if (location) return location;
  return null;
}

/**
 * Approve or deny. Either way the result is a URL to send the browser to: the
 * client's `redirect_uri` with a code, or with `error=access_denied`.
 */
export async function decideOAuthConsent(input: {
  userId: string;
  teamId: string;
  accept: boolean;
  /** The consent page's full query string (signed by the provider). */
  oauthQuery: string;
  headers: Headers;
}): Promise<{ url: string }> {
  const auth = getAuth();
  const oauthQuery = resolveOAuthQuery(input.oauthQuery).replace(/^\?/, '');
  const queryParams = new URLSearchParams(oauthQuery);
  try {
    const result = await auth.api.oauth2Consent({
      headers: jsonConsentHeaders(input.headers),
      body: { accept: input.accept, oauth_query: oauthQuery },
    });
    const url = consentRedirectUrl(result);
    if (!url) {
      throw new ValidationError(CONSENT_STALE_MESSAGE);
    }
    logger.info('oauth consent decided', {
      userId: input.userId,
      teamId: input.teamId,
      accept: input.accept,
      clientId: queryParams.get('client_id'),
    });
    return { url };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    const thrownUrl = consentRedirectUrl(error);
    if (thrownUrl) {
      logger.info('oauth consent decided via redirect', {
        userId: input.userId,
        teamId: input.teamId,
        accept: input.accept,
        clientId: queryParams.get('client_id'),
      });
      return { url: thrownUrl };
    }
    logger.warn('oauth consent rejected', {
      hasSig: queryParams.has('sig'),
      baParamCount: queryParams.getAll('ba_param').length,
      keyCount: [...queryParams.keys()].length,
      reason: oauthProviderUserMessage(error, CONSENT_STALE_MESSAGE),
    });
    throw new ValidationError(
      oauthProviderUserMessage(error, CONSENT_STALE_MESSAGE)
    );
  }
}

/** Apps the user has granted access to, newest first. */
export async function listAuthorizedApps(
  headers: Headers
): Promise<AuthorizedApp[]> {
  const auth = getAuth();
  const consents = await auth.api.getOAuthConsents({ headers });
  const clients = new Map<string, OAuthClientSummary>();
  const apps: AuthorizedApp[] = [];
  for (const consent of consents) {
    let client = clients.get(consent.clientId);
    if (!client) {
      try {
        client = toClientSummary(
          await auth.api.getOAuthClientPublic({
            headers,
            query: { client_id: consent.clientId },
          })
        );
      } catch (error) {
        if (!(error instanceof APIError)) throw error;
        if (error.statusCode !== 404) throw error;
        logger.warn('authorized app client lookup missed', {
          clientId: consent.clientId,
        });
        client = {
          clientId: consent.clientId,
          name: 'Unknown app',
          uri: null,
          logoUri: null,
          redirectOrigin: null,
        };
      }
      clients.set(consent.clientId, client);
    }
    apps.push({
      consentId: consent.id,
      client,
      scopes: consent.scopes.map((id) => ({
        id,
        description: OAUTH_SCOPE_DESCRIPTIONS[id] ?? id,
      })),
      createdAt: consent.createdAt,
      updatedAt: consent.updatedAt,
    });
  }
  apps.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return apps;
}

/**
 * Revoke an app. The provider's delete-consent endpoint only removes the
 * consent row (it checks the caller owns it), so the refresh tokens issued
 * under it are revoked here as well — otherwise the app could keep refreshing
 * until they expired. Access tokens already in the wild are stateless JWTs
 * and run out on their own (an hour at most).
 */
export async function performAuthorizedAppRevoke(input: {
  userId: string;
  consentId: string;
  clientId: string;
  headers: Headers;
}): Promise<void> {
  const auth = getAuth();
  const consents = await auth.api.getOAuthConsents({ headers: input.headers });
  const consent = consents.find((row) => row.id === input.consentId);
  if (consent && consent.clientId !== input.clientId) {
    throw new Error('This app is no longer authorized.');
  }
  // Tokens first: if deleteConsent succeeds and this throws, retry cannot
  // find the consent and the refresh tokens would stay live.
  await revokeOAuthGrantTokens(input.userId, input.clientId);
  if (consent) {
    await auth.api.deleteOAuthConsent({
      headers: input.headers,
      body: { id: input.consentId },
    });
  }
  logger.info('oauth consent revoked', {
    userId: input.userId,
    consentId: input.consentId,
    clientId: input.clientId,
  });
}
