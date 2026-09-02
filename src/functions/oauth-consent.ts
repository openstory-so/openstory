/**
 * Dashboard side of the OAuth authorization server (#1456): the consent page
 * and the "Authorized apps" list under Settings → Developer. Thin wrappers
 * over the `@better-auth/oauth-provider` endpoints, run under the signed-in
 * user's cookie session (the same shape as `device-auth.ts`).
 */

import { getAuth } from '@/lib/auth/config';
import { OAUTH_SCOPE_DESCRIPTIONS } from '@/lib/auth/oauth-scopes';
import { resolveUserTeam, revokeOAuthGrantTokens } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { APIError } from 'better-auth/api';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

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

const consentContextSchema = z.object({
  clientId: z.string().min(1).max(512),
  scope: z.string().max(1024).default(''),
  redirectUri: z.string().max(2048).optional(),
});

export async function loadOAuthConsentContext(input: {
  userId: string;
  teamId: string;
  clientId: string;
  scope: string;
  redirectUri?: string;
  headers: Headers;
}): Promise<{
  client: OAuthClientSummary | null;
  scopes: OAuthScopeSummary[];
  team: { id: string; name: string };
}> {
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

/**
 * What the consent page renders: who is asking, for what, and which team the
 * grant will bill to. Unknown client ids read as `client: null`.
 */
export const getOAuthConsentContextFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(consentContextSchema))
  .handler(async ({ data, context }) =>
    loadOAuthConsentContext({
      userId: context.user.id,
      teamId: context.teamId,
      clientId: data.clientId,
      scope: data.scope,
      redirectUri: data.redirectUri,
      headers: getRequestHeaders(),
    })
  );

const decideSchema = z.object({
  accept: z.boolean(),
  /** The consent page's full query string (signed by the provider). */
  oauthQuery: z.string().min(1).max(8192),
});

/**
 * Approve or deny. Either way the result is a URL to send the browser to: the
 * client's `redirect_uri` with a code, or with `error=access_denied`.
 */
export const decideOAuthConsentFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(decideSchema))
  .handler(async ({ data, context }): Promise<{ url: string }> => {
    const auth = getAuth();
    const oauthQuery = data.oauthQuery.replace(/^\?/, '');
    const result = await auth.api.oauth2Consent({
      headers: getRequestHeaders(),
      body: { accept: data.accept, oauth_query: oauthQuery },
    });
    logger.info('oauth consent decided', {
      userId: context.user.id,
      teamId: context.teamId,
      accept: data.accept,
      clientId: new URLSearchParams(oauthQuery).get('client_id'),
    });
    return { url: result.url };
  });

export type AuthorizedApp = {
  consentId: string;
  client: OAuthClientSummary;
  scopes: OAuthScopeSummary[];
  createdAt: Date;
  updatedAt: Date;
};

/** Apps the user has granted access to, newest first. */
export const listAuthorizedAppsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async (): Promise<AuthorizedApp[]> => {
    const auth = getAuth();
    const headers = getRequestHeaders();
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
  });

const revokeSchema = z.object({
  consentId: z.string().min(1),
  clientId: z.string().min(1),
});

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

export const revokeAuthorizedAppFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(revokeSchema))
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    await performAuthorizedAppRevoke({
      userId: context.user.id,
      consentId: data.consentId,
      clientId: data.clientId,
      headers: getRequestHeaders(),
    });
    return { success: true };
  });
