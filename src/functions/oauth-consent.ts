/**
 * Server fns for the OAuth consent page and the "Authorized apps" list
 * (#1456). Wrappers only: the logic lives in `src/lib/auth/oauth-consent.ts`,
 * referenced from handler bodies alone so the client bundle keeps none of it
 * (`src/lib/client-server-boundary.test.ts`).
 */

import {
  decideOAuthConsent,
  listAuthorizedApps,
  loadOAuthConsentContext,
  performAuthorizedAppRevoke,
  type AuthorizedApp,
  type OAuthConsentContext,
} from '@/lib/auth/oauth-consent';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

export type {
  AuthorizedApp,
  OAuthClientSummary,
  OAuthConsentContext,
  OAuthScopeSummary,
} from '@/lib/auth/oauth-consent';

const consentContextSchema = z.object({
  clientId: z.string().min(1).max(512),
  scope: z.string().max(1024).default(''),
  redirectUri: z.string().max(2048).optional(),
});

/**
 * What the consent page renders: who is asking, for what, and which team the
 * grant will bill to. Unknown client ids read as `client: null`.
 */
export const getOAuthConsentContextFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(consentContextSchema))
  .handler(async ({ data, context }): Promise<OAuthConsentContext> =>
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
  .handler(async ({ data, context }): Promise<{ url: string }> =>
    decideOAuthConsent({
      userId: context.user.id,
      teamId: context.teamId,
      accept: data.accept,
      oauthQuery: data.oauthQuery,
      headers: getRequestHeaders(),
    })
  );

/** Apps the user has granted access to, newest first. */
export const listAuthorizedAppsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async (): Promise<AuthorizedApp[]> =>
    listAuthorizedApps(getRequestHeaders())
  );

const revokeSchema = z.object({
  consentId: z.string().min(1),
  clientId: z.string().min(1),
});

/** Revoke an app: its consent and the refresh tokens issued under it. */
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
