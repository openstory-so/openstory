/**
 * Dashboard side of the OAuth authorization server (#1456): the consent page
 * and the "Authorized apps" list under Settings → Developer. Thin wrappers
 * over the `@better-auth/oauth-provider` endpoints, run under the signed-in
 * user's cookie session (the same shape as `device-auth.ts`).
 *
 * Server-only. The `createServerFn` wrappers live in
 * `src/platform/oauth-consent.fn.ts`; the logic is here because anything a
 * `src/functions/*` module exports besides a server fn survives the Start
 * compiler's client strip and would drag the Better Auth config into the
 * browser bundle (`src/platform/client-server-boundary.test.ts`).
 */

import { getAuth } from './config';
import {
  consentOrganization,
  resolveOAuthIssuer,
  rewriteAuthorizationIss,
} from './oauth-provider';
import { resolveOAuthQuery } from '@/platform/auth/oauth-query-snapshot';
import { OAUTH_SCOPE_DESCRIPTIONS } from './oauth-scopes';
import {
  getUserOrganizationMembership,
  listUserOrganizations,
  revokeOAuthGrantTokens,
  type OrganizationOption,
} from '@/platform/server/db/scoped';
import { ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import {
  MODELS_INVOKE_SCOPE,
  monthlyCapMicrosSchema,
  requestsModelsInvoke,
} from '@/platform/auth/oauth-spend-cap';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { AppTerms, AppTermsView, GrantStanding } from '@/gateway/apps';
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
  organizations: OrganizationOption[];
  activeOrganizationId: string;
  /** Asked for `models:invoke`, so approving needs a monthly cap. */
  needsSpendCap: boolean;
  /** The live cap this client already has, per organization id, in microdollars. */
  currentCaps: Record<string, number>;
  /** What a registered app adds on top of model costs and its SKUs; approving accepts them. */
  appTerms: AppTermsView | null;
};

export type AuthorizedApp = {
  consentId: string;
  client: OAuthClientSummary;
  scopes: OAuthScopeSummary[];
  /** The organization the consent bills; null for a consent with none. */
  organization: OrganizationOption | null;
  /** Holds `models:invoke`, so it can spend through the gateway. */
  invokesModels: boolean;
  /** The live spend cap and this month's use; null when there is none. */
  grant: GrantStanding | null;
  /** The margin and SKU prices the user approved on the grant; null without one. */
  accepted: AppTerms | null;
  /** What the app asks now, when it is a registered, active app. */
  appTerms: AppTermsView | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The grant methods the consent flows write through (the signed-in user's). */
type UserGrants = Pick<
  ScopedDb['gatewayGrants'],
  'listStandings' | 'setCap' | 'revoke' | 'acceptTerms'
>;

/** Reads a client's app terms (any organization's app). */
type AppTermsReader = Pick<ScopedDb['gatewayApps'], 'getTermsByOAuthClient'>;

/** Approving accepts nothing the page did not show. */
const NOTHING_SHOWN: AppTerms = { marginBps: 0, skuPrices: {} };

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
 * What the consent page renders: who is asking, for what, and the
 * organizations the grant can bill to. Unknown client ids read as `client: null`.
 */
export async function loadOAuthConsentContext(input: {
  userId: string;
  organizationId: string;
  clientId: string;
  scope: string;
  redirectUri?: string;
  headers: Headers;
  grants: Pick<UserGrants, 'listStandings'>;
  apps: AppTermsReader;
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
  const needsSpendCap = requestsModelsInvoke(input.scope);
  const currentCaps: Record<string, number> = {};
  if (needsSpendCap) {
    for (const grant of await input.grants.listStandings()) {
      if (grant.oauthClientId === input.clientId) {
        currentCaps[grant.organizationId] = grant.monthlyCapMicros;
      }
    }
  }
  return {
    client,
    scopes: scopeSummaries(input.scope),
    organizations: await listUserOrganizations(input.userId),
    activeOrganizationId: input.organizationId,
    needsSpendCap,
    currentCaps,
    appTerms:
      client && needsSpendCap
        ? await input.apps.getTermsByOAuthClient(input.clientId)
        : null,
  };
}

/** The cap an approval must carry, or a ValidationError. */
function requireMonthlyCap(value: number | null | undefined): number {
  const parsed = monthlyCapMicrosSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(
      'Set a monthly spend cap in whole dollars within the allowed range before approving.'
    );
  }
  return parsed.data;
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
  organizationId: string;
  accept: boolean;
  /** The consent page's full query string (signed by the provider). */
  oauthQuery: string;
  /** Required to approve a request for `models:invoke`; ignored otherwise. */
  monthlyCapMicros?: number | null;
  /** The app's margin and SKU prices the page showed; approving records no more. */
  shownTerms?: AppTerms | null;
  headers: Headers;
  grants: Pick<UserGrants, 'setCap'>;
}): Promise<{ url: string }> {
  if (
    input.accept &&
    !(await getUserOrganizationMembership(input.userId, input.organizationId))
  ) {
    throw new ValidationError('You are not a member of that organization');
  }
  const oauthQuery = resolveOAuthQuery(input.oauthQuery).replace(/^\?/, '');
  const queryParams = new URLSearchParams(oauthQuery);
  const clientId = queryParams.get('client_id');
  // The signed query's scope: the provider rejects a tampered one on the POST.
  const capMicros =
    input.accept && requestsModelsInvoke(queryParams.get('scope') ?? '')
      ? requireMonthlyCap(input.monthlyCapMicros)
      : null;
  if (capMicros !== null && !clientId) {
    throw new ValidationError(CONSENT_STALE_MESSAGE);
  }
  const origin = consentApiOrigin(input.headers);
  const headers = consentRequestHeaders(input.headers);
  headers.set('Origin', origin);
  let res: Response;
  try {
    // In-process: a worker `fetch()` to the public origin can drop the
    // session cookie / CSRF origin. `auth.handler` is the same POST
    // `/api/auth/oauth2/consent` Better Auth's client uses.
    res = await consentOrganization.run(input.organizationId, () =>
      getAuth().handler(
        new Request(`${origin}/api/auth/oauth2/consent`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            accept: input.accept,
            oauth_query: oauthQuery,
          }),
        })
      )
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
    if (capMicros !== null && clientId && consentGranted(redirect)) {
      const written = await input.grants.setCap({
        oauthClientId: clientId,
        organizationId: input.organizationId,
        monthlyCapMicros: capMicros,
        shownTerms: input.shownTerms ?? NOTHING_SHOWN,
      });
      if (!written) {
        throw new ValidationError('You are not a member of that organization');
      }
    }
    logger.info('oauth consent decided', {
      userId: input.userId,
      organizationId: input.organizationId,
      accept: input.accept,
      clientId,
      monthlyCapMicros: capMicros,
      shownMarginBps:
        capMicros === null ? null : (input.shownTerms?.marginBps ?? 0),
    });
    return { url: rewriteAuthorizationIss(redirect, origin) };
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

/** The redirect carries no error: the provider recorded the consent. */
function consentGranted(redirect: string): boolean {
  try {
    return !new URL(redirect, 'https://placeholder.invalid').searchParams.has(
      'error'
    );
  } catch {
    return false;
  }
}

/** Apps the user has granted access to, newest first. */
export async function listAuthorizedApps(input: {
  userId: string;
  headers: Headers;
  grants: Pick<UserGrants, 'listStandings'>;
  apps: AppTermsReader;
}): Promise<AuthorizedApp[]> {
  const { headers } = input;
  const auth = getAuth();
  const consents = await auth.api.getOAuthConsents({ headers });
  const [organizations, standings] = await Promise.all([
    listUserOrganizations(input.userId),
    input.grants.listStandings(),
  ]);
  const clients = new Map<string, OAuthClientSummary>();
  const terms = new Map<string, AppTermsView | null>();
  const termsOf = async (clientId: string) => {
    if (!terms.has(clientId)) {
      terms.set(clientId, await input.apps.getTermsByOAuthClient(clientId));
    }
    return terms.get(clientId) ?? null;
  };
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
    const organization =
      organizations.find((org) => org.id === consent.referenceId) ?? null;
    const standing = organization
      ? standings.find(
          (grant) =>
            grant.oauthClientId === consent.clientId &&
            grant.organizationId === organization.id
        )
      : undefined;
    const invokesModels = consent.scopes.includes(MODELS_INVOKE_SCOPE);
    apps.push({
      consentId: consent.id,
      client,
      scopes: consent.scopes.map((id) => ({
        id,
        description: OAUTH_SCOPE_DESCRIPTIONS[id] ?? id,
      })),
      organization,
      invokesModels,
      grant: standing
        ? {
            monthlyCapMicros: standing.monthlyCapMicros,
            spentMicros: standing.spentMicros,
            heldMicros: standing.heldMicros,
            remainingMicros: standing.remainingMicros,
          }
        : null,
      accepted: standing?.accepted ?? null,
      appTerms: invokesModels ? await termsOf(consent.clientId) : null,
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
  grants: Pick<UserGrants, 'revoke'>;
}): Promise<void> {
  const auth = getAuth();
  const consents = await auth.api.getOAuthConsents({ headers: input.headers });
  const consent = consents.find((row) => row.id === input.consentId);
  if (consent && consent.clientId !== input.clientId) {
    throw new Error('This app is no longer authorized.');
  }
  // The spend grant first, so a still-valid access token stops spending now.
  // Without the consent (a retry) every organization's grant goes, as the
  // tokens below do.
  await input.grants.revoke({
    oauthClientId: input.clientId,
    organizationId: consent?.referenceId ?? null,
  });
  // Tokens before the consent: if deleteConsent succeeds and this throws,
  // retry cannot find the consent and the refresh tokens would stay live.
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

/**
 * Change the monthly cap of an authorized app that holds `models:invoke`.
 * Creates the grant when the consent has none (one approved before caps).
 */
export async function setAuthorizedAppCap(input: {
  consentId: string;
  monthlyCapMicros: number;
  headers: Headers;
  grants: Pick<UserGrants, 'setCap'>;
}): Promise<void> {
  const monthlyCapMicros = requireMonthlyCap(input.monthlyCapMicros);
  const consents = await getAuth().api.getOAuthConsents({
    headers: input.headers,
  });
  const consent = consents.find((row) => row.id === input.consentId);
  if (!consent?.referenceId || !consent.scopes.includes(MODELS_INVOKE_SCOPE)) {
    throw new ValidationError('This app cannot spend credits through models.');
  }
  const written = await input.grants.setCap({
    oauthClientId: consent.clientId,
    organizationId: consent.referenceId,
    monthlyCapMicros,
  });
  if (!written) {
    throw new ValidationError(
      'You are no longer a member of the organization this app bills.'
    );
  }
}

/**
 * Approve an authorized app's current margin and SKU prices, as Settings
 * showed them. Needs a live grant; records no more than the app asks now.
 */
export async function acceptAuthorizedAppTerms(input: {
  consentId: string;
  shownTerms: AppTerms;
  headers: Headers;
  grants: Pick<UserGrants, 'acceptTerms'>;
}): Promise<void> {
  const consents = await getAuth().api.getOAuthConsents({
    headers: input.headers,
  });
  const consent = consents.find((row) => row.id === input.consentId);
  if (!consent?.referenceId || !consent.scopes.includes(MODELS_INVOKE_SCOPE)) {
    throw new ValidationError('This app cannot spend credits through models.');
  }
  const written = await input.grants.acceptTerms({
    oauthClientId: consent.clientId,
    organizationId: consent.referenceId,
    shownTerms: input.shownTerms,
  });
  if (!written) {
    throw new ValidationError(
      'Set a monthly spend cap for this app before accepting its prices.'
    );
  }
}
