/**
 * Server fns for the OAuth consent page and the "Authorized apps" list
 * (#1456). Wrappers only: the logic lives in `src/platform/server/auth/oauth-consent.ts`,
 * referenced from handler bodies alone so the client bundle keeps none of it
 * (`src/platform/client-server-boundary.test.ts`).
 */

import {
  decideOAuthConsent,
  listAuthorizedApps,
  loadOAuthConsentContext,
  performAuthorizedAppRevoke,
  setAuthorizedAppCap,
  type AuthorizedApp,
  type OAuthConsentContext,
} from '@/platform/server/auth/oauth-consent';
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithOrganizationMiddleware } from './middleware.fn';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';

export type {
  AuthorizedApp,
  OAuthClientSummary,
  OAuthConsentContext,
  OAuthScopeSummary,
} from '@/platform/server/auth/oauth-consent';

const consentContextSchema = z.object({
  clientId: z.string().min(1).max(512),
  scope: z.string().max(1024).default(''),
  redirectUri: z.string().max(2048).optional(),
});

/**
 * What the consent page renders: who is asking, for what, and the
 * organizations the grant can bill to. Unknown client ids read as `client: null`.
 */
export const getOAuthConsentContextFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(consentContextSchema))
  .handler(async ({ data, context }): Promise<OAuthConsentContext> =>
    loadOAuthConsentContext({
      userId: context.user.id,
      organizationId: context.organizationId,
      clientId: data.clientId,
      scope: data.scope,
      redirectUri: data.redirectUri,
      headers: getRequestHeaders(),
      grants: context.scopedDb.gatewayGrants,
    })
  );

const decideSchema = z.object({
  accept: z.boolean(),
  organizationId: ulidSchema,
  /** The consent page's full query string (signed by the provider). */
  oauthQuery: z.string().min(1).max(8192),
  /** The monthly spend cap, in microdollars; required to approve `models:invoke`. */
  monthlyCapMicros: z.number().int().nullable().optional(),
});

/**
 * Approve or deny. Either way the result is a URL to send the browser to: the
 * client's `redirect_uri` with a code, or with `error=access_denied`.
 */
export const decideOAuthConsentFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(decideSchema))
  .handler(async ({ data, context }): Promise<{ url: string }> =>
    decideOAuthConsent({
      userId: context.user.id,
      organizationId: data.organizationId,
      accept: data.accept,
      oauthQuery: data.oauthQuery,
      monthlyCapMicros: data.monthlyCapMicros,
      headers: getRequestHeaders(),
      grants: context.scopedDb.gatewayGrants,
    })
  );

/** Apps the user has granted access to, newest first. */
export const listAuthorizedAppsFn = createServerFn({ method: 'GET' })
  .middleware([authWithOrganizationMiddleware])
  .handler(async ({ context }): Promise<AuthorizedApp[]> =>
    listAuthorizedApps({
      userId: context.user.id,
      headers: getRequestHeaders(),
      grants: context.scopedDb.gatewayGrants,
    })
  );

const revokeSchema = z.object({
  consentId: z.string().min(1),
  clientId: z.string().min(1),
});

/** Revoke an app: its consent and the refresh tokens issued under it. */
export const revokeAuthorizedAppFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(revokeSchema))
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    await performAuthorizedAppRevoke({
      userId: context.user.id,
      consentId: data.consentId,
      clientId: data.clientId,
      headers: getRequestHeaders(),
      grants: context.scopedDb.gatewayGrants,
    });
    return { success: true };
  });

const setCapSchema = z.object({
  consentId: z.string().min(1),
  monthlyCapMicros: z.number().int(),
});

/** Change an authorized app's monthly spend cap. */
export const setAuthorizedAppCapFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(setCapSchema))
  .handler(async ({ data, context }): Promise<{ success: true }> => {
    await setAuthorizedAppCap({
      consentId: data.consentId,
      monthlyCapMicros: data.monthlyCapMicros,
      headers: getRequestHeaders(),
      grants: context.scopedDb.gatewayGrants,
    });
    return { success: true };
  });
