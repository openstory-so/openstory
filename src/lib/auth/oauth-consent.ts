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
import { resolveOAuthIssuer } from '@/lib/auth/oauth-provider';
import { resolveOAuthQuery } from '@/shared/auth/oauth-query-snapshot';
import { OAUTH_SCOPE_DESCRIPTIONS } from '@/lib/auth/oauth-scopes';
import { resolveUserTeam, revokeOAuthGrantTokens } from '@/lib/db/scoped';
import { ValidationError } from '@/shared/errors';
import { getLogger } from '@/shared/observability/logger';
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
function providerErrorText(body: {
  error?: string;
  error_description?: string;
  message?: string;
}): string | null {
  if (body.error === 'invalid_signature') return null;
  const text = body.error_description || body.message;
  return text?.trim() ? text : null;
}

export function oauthProviderUserMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof APIError) {
    const body = error.body as
      | { error?: string; error_description?: string; message?: string }
      | undefined;
    if (body) {
      const text = providerErrorText(body);
      if (text) return text;
      if (body.error === 'invalid_signature') return fallback;
    }
  } else if (error && typeof error === 'object') {
    const errorCode = 'error' in error ? error.error : undefined;
    const description =
      'error_description' in error ? error.error_description : undefined;
    const message = 'message' in error ? error.message : undefined;
    const text = providerErrorText({
      error: typeof errorCode === 'string' ? errorCode : undefined,
      error_description:
        typeof description === 'string' ? description : undefined,
      message: typeof message === 'string' ? message : undefined,
    });
    if (text) return text;
    if (errorCode === 'invalid_signature') return fallback;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function consentApiOrigin(headers: Headers): string {
  const origin = headers.get('origin');
  if (origin) return origin.replace(/\/$/, '');
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (host) {
    const proto = headers.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${host}`;
  }
  return resolveOAuthIssuer();
}

function consentRequestHeaders(headers: Headers): Headers {
  const next = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Sec-Fetch-Mode': 'cors',
  });
  const cookie = headers.get('cookie');
  if (cookie) next.set('Cookie', cookie);
  return next;
}

const API_ERROR_HEADERS = Symbol.for('better-call:api-error-headers');

function headerLocation(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null;
  if (headers instanceof Headers) {
    return headers.get('Location') ?? headers.get('location');
  }
  if ('get' in headers && typeof headers.get === 'function') {
    const loc = headers.get('Location') ?? headers.get('location');
    if (typeof loc === 'string' && loc.length > 0) return loc;
  }
  if ('location' in headers && typeof headers.location === 'string') {
    return headers.location;
  }
  if ('Location' in headers && typeof headers.Location === 'string') {
    return headers.Location;
  }
  return null;
}

/** `oauth2Consent` OpenAPI says `redirect_uri`; the JS client also uses `url`. */
export function consentRedirectUrl(result: unknown): string | null {
  if (!result) return null;
  if (result instanceof Response) {
    return headerLocation(result.headers);
  }
  if (typeof result !== 'object') return null;
  if ('url' in result && typeof result.url === 'string' && result.url) {
    return result.url;
  }
  if (
    'redirect_uri' in result &&
    typeof result.redirect_uri === 'string' &&
    result.redirect_uri
  ) {
    return result.redirect_uri;
  }
  const headers = 'headers' in result ? result.headers : undefined;
  const hidden =
    API_ERROR_HEADERS in result ? result[API_ERROR_HEADERS] : undefined;
  return headerLocation(headers) ?? headerLocation(hidden);
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
  const oauthQuery = resolveOAuthQuery(input.oauthQuery).replace(/^\?/, '');
  const queryParams = new URLSearchParams(oauthQuery);
  const origin = consentApiOrigin(input.headers);
  const headers = consentRequestHeaders(input.headers);
  headers.set('Origin', origin);
  let res: Response;
  try {
    // In-process: a worker `fetch()` to the public origin can drop the
    // session cookie / CSRF origin. `auth.handler` is the same POST
    // `/api/auth/oauth2/consent` Better Auth's client uses.
    res = await getAuth().handler(
      new Request(`${origin}/api/auth/oauth2/consent`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          accept: input.accept,
          oauth_query: oauthQuery,
        }),
      })
    );
  } catch (error) {
    logger.warn('oauth consent fetch failed', {
      hasSig: queryParams.has('sig'),
      baParamCount: queryParams.getAll('ba_param').length,
      reason: oauthProviderUserMessage(error, CONSENT_STALE_MESSAGE),
    });
    throw new ValidationError(
      oauthProviderUserMessage(error, CONSENT_STALE_MESSAGE)
    );
  }
  let redirect = headerLocation(res.headers);
  let body: unknown = null;
  if (!redirect) {
    try {
      body = await res.json();
      redirect = consentRedirectUrl(body);
    } catch {
      body = null;
    }
  }
  if (redirect) {
    logger.info('oauth consent decided', {
      userId: input.userId,
      teamId: input.teamId,
      accept: input.accept,
      clientId: queryParams.get('client_id'),
    });
    return { url: redirect };
  }
  logger.warn('oauth consent rejected', {
    hasSig: queryParams.has('sig'),
    baParamCount: queryParams.getAll('ba_param').length,
    keyCount: [...queryParams.keys()].length,
    status: res.status,
    reason: oauthProviderUserMessage(body, CONSENT_STALE_MESSAGE),
  });
  throw new ValidationError(
    oauthProviderUserMessage(body, CONSENT_STALE_MESSAGE)
  );
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
