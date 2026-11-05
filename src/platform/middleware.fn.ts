/**
 * Server Function Middleware
 * Reusable middleware for authentication, organization access, and resource validation
 */

import { scheduleFlushAnalytics } from '#flush-scheduler';
import {
  requireOrganizationAdminAccess,
  requireOrganizationMemberAccess,
  requireOrganizationOwnerAccess,
} from '@/platform/server/auth/action-utils';
import type { Session, User } from '@/platform/server/auth/config';
import { getAuth } from '@/platform/server/auth/config';
import { bearerChallengeHeaders } from '@/platform/server/auth/oauth-bearer';
import {
  apiResourceMetadataUrl,
  authErrorResponse,
  resolveRequestPrincipal,
} from '@/platform/server/auth/request-principal';
import { requiredOAuthScope } from '@/platform/server/api-v1/oauth-scopes';
import {
  isSystemAdmin,
  requireSystemAdmin,
} from '@/platform/server/auth/system-admin';
import {
  createScopedDb,
  createSystemAdminScopedDb,
  getFirstOrganizationId,
  getSequenceByIdUnscoped,
  type ScopedDb,
} from '@/platform/server/db/scoped';
import {
  assertCanWrite,
  restrictionNotice,
} from '@/platform/server/compliance/enforcement';
import { resolveOrganizationAndCompliance } from '@/platform/server/auth/organization-memo';
import {
  AccountRestrictedError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
} from './errors';
import { errorHeadline, getLogger, toErrorPayload } from './logger';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import type { Sequence } from '@/platform/server/db/schema';
import { getEnv } from '#env';
import {
  D1_BOOKMARK_COOKIE,
  parseBookmark,
  runInReadSession,
} from '@/platform/server/db/d1-session';
import { createMiddleware } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

// ============================================================================
// Context Types
// ============================================================================

export type AuthContext = {
  user: User;
  session: Session;
};

export type OrganizationContext = AuthContext & {
  organizationId: string;
  scopedDb: ScopedDb;
};

export type SequenceContext = OrganizationContext & {
  sequence: Sequence;
};

// ============================================================================
// Logger Middleware
// ============================================================================

/**
 * Request logging middleware. Logs at:
 *   - error: serverFn failures, except the expected rejections below
 *   - warn:  EXPECTED_REJECTION_CODES, oversize bodies (>6 MB), slow (>2s)
 *   - info:  successes that crossed the SLOW_THRESHOLD_MS (>500ms)
 *   - debug: fast successes (kept silent at INFO+ to avoid drowning errors)
 *
 * Headlines are self-describing so they're readable in PostHog/Cloudflare
 * Logs without expanding fields.
 */
const SIZE_WARNING_BYTES = 6 * 1024 * 1024; // 6 MB
const SLOW_THRESHOLD_MS = 500;
const VERY_SLOW_THRESHOLD_MS = 2000;

/**
 * Error codes that represent a user-facing outcome rather than a fault, and so
 * log at `warn`. Add a code here only when a spike of it would NOT be worth
 * paging on — everything else must stay at `error`.
 */
export const EXPECTED_REJECTION_CODES = new Set([
  // Signed-out or expired sessions are expected on the anonymous app shell.
  'AUTHENTICATION_ERROR',
  // A write from a member who was removed mid-session (#813).
  'AUTHORIZATION_ERROR',
  'INSUFFICIENT_CREDITS',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  // Upload-rights gate (#1581): the client is supposed to attest first; a
  // miss is a 400 the user can complete, not a fault.
  'ATTESTATION_REQUIRED',
]);
const serverFnLogger = getLogger(['openstory', 'serverFn']);

export const loggerMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    const start = performance.now();
    const request = getRequest();
    const contentLength = request.headers.get('content-length');
    const contentLengthNum = contentLength ? Number(contentLength) : undefined;
    const fnName = serverFnMeta.name;
    const method = request.method;
    const path = new URL(request.url).pathname;
    const fnLogger = serverFnLogger.with({
      fnName,
      method,
      path,
      contentLength: contentLengthNum,
    });

    if (contentLengthNum && contentLengthNum > SIZE_WARNING_BYTES) {
      fnLogger.warn('serverFn {fnName} oversize body {contentLength}b', {
        fnName,
        contentLength: contentLengthNum,
      });
    }

    try {
      const result = await next();
      const durationMs = Math.round(performance.now() - start);
      if (durationMs >= VERY_SLOW_THRESHOLD_MS) {
        fnLogger.warn('serverFn {fnName} very slow {durationMs}ms', {
          fnName,
          durationMs,
        });
      } else if (durationMs >= SLOW_THRESHOLD_MS) {
        fnLogger.info('serverFn {fnName} slow {durationMs}ms', {
          fnName,
          durationMs,
        });
      } else {
        fnLogger.debug('serverFn {fnName} ok {durationMs}ms', {
          fnName,
          durationMs,
        });
      }
      return result;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const err = toErrorPayload(error);
      const logPayload = {
        fnName,
        durationMs,
        errCode: err.code,
        // Reason-first and length-capped: a raw driver message (drizzle puts
        // the whole SQL statement there) would otherwise fill the body's
        // truncation budget and evict the cause — see errorHeadline (#1135).
        errMessage: errorHeadline(err),
        err,
      };
      // Expected business rejections are outcomes, not failures: warn, so prod
      // error logs stay signal (#1099). Deliberately an allowlist of codes and
      // NOT `statusCode < 500` — a status range would also silence permission
      // failures and anything a handler mislabels as a 4xx.
      if (EXPECTED_REJECTION_CODES.has(err.code)) {
        fnLogger.warn(
          'serverFn {fnName} rejected: {errCode} {errMessage}',
          logPayload
        );
      } else {
        fnLogger.error(
          'serverFn {fnName} failed: {errCode} {errMessage}',
          logPayload
        );
      }
      throw error;
    }
  }
);

// ============================================================================
// D1 read replication (#2233)
// ============================================================================

/**
 * Request middleware: every query in the request reads from a D1 replica near
 * the user, at or after the bookmark in the `d1_bookmark` cookie, which the
 * response moves forward so the next request sees this one's writes. A
 * client that sends a key instead of cookies starts on the primary, so its
 * first query already sees the call before it.
 */
export const d1SessionMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const incoming = parseBookmark(request.headers.get('cookie'));
    const keyed =
      request.headers.has('authorization') || request.headers.has('x-api-key');
    const { value, bookmark } = await runInReadSession(
      getEnv().DB,
      keyed ? 'first-primary' : (incoming ?? 'first-unconstrained'),
      async () => next()
    );
    if (!bookmark || bookmark === incoming) return value;

    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    const cookie = `${D1_BOOKMARK_COOKIE}=${bookmark}; Path=/; Max-Age=300; HttpOnly; SameSite=Lax${secure}`;
    try {
      value.response.headers.append('set-cookie', cookie);
      return value;
    } catch {
      // Immutable headers (a redirect or a fetched response): copy, then set.
      const response = new Response(value.response.body, value.response);
      response.headers.append('set-cookie', cookie);
      return response;
    }
  }
);

// ============================================================================
// Auth Middleware
// ============================================================================

/**
 * Request auth middleware — for use with server routes (server.middleware).
 * Unlike authMiddleware (type: 'function'), this is request-scoped and
 * receives the request object directly from the middleware params.
 */
export const authRequestMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const principal = await resolveRequestPrincipal(request);

    if (!principal) {
      throw authErrorResponse(
        401,
        'UNAUTHORIZED',
        'Valid authentication required. Provide an API key via "Authorization: Bearer <key>" or "x-api-key".'
      );
    }

    return next({
      context: {
        user: principal.user,
        session: principal.session,
      },
    });
  }
);

/**
 * Request auth + organization middleware — for use with server routes (server.middleware).
 * Authenticates user, acts for the request's organization, and creates a scoped DB.
 * Throws 401 if no user, 403 if no organization, 429 if a key is over its rate limit.
 */
export const authWithOrganizationRequestMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    // Server ROUTES don't get `analyticsFlushMiddleware` — that one is
    // `type: 'function'`, so it only composes into server functions. Without
    // a flush here, a product event captured by a route handler (e.g.
    // `sequence_generated` from the public v1 create endpoint) races isolate
    // teardown: `captureProductEvent` is fire-and-forget, and on Workers an
    // in-flight fetch is cancelled once the response is returned.
    try {
      const principal = await resolveRequestPrincipal(request);

      if (!principal) {
        throw authErrorResponse(
          401,
          'UNAUTHORIZED',
          'Valid authentication required. Provide an API key via "Authorization: Bearer <key>" or "x-api-key".',
          bearerChallengeHeaders({
            resourceMetadataUrl: apiResourceMetadataUrl(),
          })
        );
      }
      // OAuth tokens are scoped (an `osk_` key has the full API) and bill the
      // organization chosen at consent, which must still be one the user belongs to.
      const { oauth } = principal;
      if (oauth) {
        const scope = requiredOAuthScope(request);
        if (scope && !oauth.scopes.includes(scope)) {
          throw authErrorResponse(
            403,
            'INSUFFICIENT_SCOPE',
            `This request needs the "${scope}" scope. Re-authorize the app with that scope.`,
            bearerChallengeHeaders({
              resourceMetadataUrl: apiResourceMetadataUrl(),
              error: 'insufficient_scope',
              scope: [scope],
            })
          );
        }
      }

      const { organization, compliance } = principal.organizationId
        ? await resolveOrganizationAndCompliance(
            principal.user.id,
            request.method,
            principal.organizationId
          )
        : { organization: null, compliance: null };

      if (!organization || !compliance) {
        throw authErrorResponse(
          403,
          'NO_ORGANIZATION',
          oauth
            ? 'This token was issued for an organization you no longer belong to. Re-authorize the app.'
            : 'This key or session is not linked to an organization you belong to.'
        );
      }
      if (!compliance.enforcement.canAccess) {
        throw authErrorResponse(
          403,
          'ACCOUNT_RESTRICTED',
          restrictionNotice(compliance.enforcement) ??
            'This account may not use the service'
        );
      }
      if (request.method !== 'GET' && !compliance.enforcement.canWrite) {
        throw authErrorResponse(
          403,
          'ACCOUNT_RESTRICTED',
          restrictionNotice(compliance.enforcement) ??
            'This account is read-only'
        );
      }

      return await next({
        context: {
          user: principal.user,
          session: principal.session,
          oauth: principal.oauth,
          organizationId: organization.organizationId,
          scopedDb: createScopedDb(
            organization.organizationId,
            principal.user.id
          ),
        },
      });
    } finally {
      await scheduleFlushAnalytics();
    }
  }
);

/**
 * Basic auth middleware - requires authenticated user
 * Adds user and session to context
 */
export const authMiddleware = createMiddleware({ type: 'function' }).server(
  async ({ next }) => {
    const request = getRequest();
    const auth = getAuth();
    const session = await auth.api.getSession({ headers: request.headers });

    if (!session?.user) {
      throw new AuthenticationError('Authentication required');
    }

    return next({
      context: {
        user: session.user,
        session,
      },
    });
  }
);

/**
 * Analytics flush middleware — schedules a PostHog flush after the handler
 * returns so buffered events ship before serverless isolates suspend.
 */
const analyticsFlushMiddleware = createMiddleware({ type: 'function' })
  .middleware([authMiddleware])
  .server(async ({ next }) => {
    try {
      return await next();
    } finally {
      // Schedule (don't await) so the PostHog flush doesn't add to the
      // user-visible request duration. On Workers this uses `waitUntil` to
      // keep the isolate alive; in dev/test it falls back to awaiting.
      // See issue #770.
      await scheduleFlushAnalytics();
    }
  });

/**
 * Auth with the session's active organization
 */
export const authWithOrganizationMiddleware = createMiddleware({
  type: 'function',
})
  .middleware([analyticsFlushMiddleware])
  .server(async ({ next, context }) => {
    const request = getRequest();
    const activeId = context.session.session.activeOrganizationId;
    let { organization, compliance } = activeId
      ? await resolveOrganizationAndCompliance(
          context.user.id,
          request.method,
          activeId
        )
      : { organization: null, compliance: null };

    // Leaving clears the active organization and removal leaves it dangling.
    // A read moves to the first one so the app can paint; a write is refused,
    // or it would land in an organization the user never chose.
    if (!organization || !compliance) {
      if (request.method !== 'GET') {
        throw new AuthorizationError(
          'You are no longer a member of this organization. Switch organization and try again.'
        );
      }
      const firstId = await getFirstOrganizationId(context.user.id);
      if (!firstId) throw new Error('This account belongs to no organization');
      await getAuth().api.setActiveOrganization({
        headers: request.headers,
        body: { organizationId: firstId },
      });
      ({ organization, compliance } = await resolveOrganizationAndCompliance(
        context.user.id,
        request.method,
        firstId
      ));
      if (!organization || !compliance) {
        throw new Error('You are not a member of the active organization');
      }
    }

    if (!compliance.enforcement.canAccess) {
      throw new AccountRestrictedError(
        restrictionNotice(compliance.enforcement) ??
          'This account may not use the service',
        {
          action: compliance.enforcement.mostSevere?.action,
          reason: compliance.enforcement.mostSevere?.reason,
          enforcementId: compliance.enforcement.mostSevere?.id,
          appealPath: '/report',
        }
      );
    }
    // Server fns: GET stays readable under account_suspended; POST/PUT/etc.
    // are writes. `getComplianceStatusFn` uses authMiddleware only so a
    // terminated account can still see the restriction banner.
    if (request.method !== 'GET') {
      assertCanWrite(compliance.enforcement);
    }

    return next({
      context: {
        organizationId: organization.organizationId,
        organizationName: organization.organizationName,
        scopedDb: createScopedDb(organization.organizationId, context.user.id),
      },
    });
  });

// ============================================================================
// System Admin Middleware
// ============================================================================

/**
 * System admin middleware - requires ADMIN_EMAILS env var match
 * Extends authWithOrganizationMiddleware so context includes organizationId
 */
export const systemAdminMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithOrganizationMiddleware])
  .server(async ({ next, context }) => {
    requireSystemAdmin(context.user.email);
    return next({
      context: {
        adminScopedDb: createSystemAdminScopedDb(),
      },
    });
  });

// ============================================================================
// Resource Access Middleware
// ============================================================================

/**
 * Sequence access middleware
 * Loads sequence and verifies organization access
 * Requires sequenceId in input data
 */
export const sequenceAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(z.looseObject({ sequenceId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    return next({ context: await loadSequence(context, data.sequenceId) });
  });

/**
 * Cast access (#2017): the sequence a character is worked on through, or
 * none (`sequenceId: null`) when the work is done from the Characters page.
 * `context.sequence` is then null, and the organization is the caller's own.
 */
export const castAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(z.looseObject({ sequenceId: ulidSchema.nullable() })))
  .server(async ({ next, context, data }) => {
    const loaded: {
      sequence: Sequence | null;
      organizationId: string;
      scopedDb: ScopedDb;
    } =
      data.sequenceId === null
        ? {
            sequence: null,
            organizationId: context.organizationId,
            scopedDb: context.scopedDb,
          }
        : await loadSequence(context, data.sequenceId);
    return next({ context: loaded });
  });

/** The sequence, scoped to its organization; a system admin reaches any organization's. */
async function loadSequence(
  context: {
    scopedDb: ScopedDb;
    organizationId: string;
    user: { id: string; email: string };
  },
  sequenceId: string
) {
  let sequence = await context.scopedDb.sequences.getById(sequenceId);
  let { organizationId, scopedDb } = context;

  if (!sequence && isSystemAdmin(context.user.email)) {
    sequence = await getSequenceByIdUnscoped(sequenceId);
    if (sequence) {
      organizationId = sequence.organizationId;
      scopedDb = createScopedDb(sequence.organizationId, context.user.id);
    }
  }

  if (!sequence) {
    throw new NotFoundError('Sequence not found');
  }
  return { sequence, organizationId, scopedDb };
}

/**
 * Organization member access middleware
 * Verifies user has access to the specified organization
 * Requires organizationId in input data
 */
export const organizationMemberAccessMiddleware = createMiddleware({
  type: 'function',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(z.looseObject({ organizationId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    if (data.organizationId !== context.organizationId) {
      await requireOrganizationMemberAccess(
        context.user.id,
        data.organizationId
      );
    }

    return next({
      context: {
        organizationId: data.organizationId,
        scopedDb:
          data.organizationId === context.organizationId
            ? context.scopedDb
            : createScopedDb(data.organizationId, context.user.id),
      },
    });
  });

/**
 * Organization admin access middleware
 * Verifies user has admin access to the specified organization
 * Requires organizationId in input data
 */
export const organizationAdminAccessMiddleware = createMiddleware({
  type: 'function',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(z.looseObject({ organizationId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    await requireOrganizationAdminAccess(context.user.id, data.organizationId);

    return next({
      context: {
        organizationId: data.organizationId,
        scopedDb:
          data.organizationId === context.organizationId
            ? context.scopedDb
            : createScopedDb(data.organizationId, context.user.id),
      },
    });
  });

/**
 * Organization owner access middleware
 * Verifies user has owner access to the specified organization
 * Requires organizationId in input data
 */
export const organizationOwnerAccessMiddleware = createMiddleware({
  type: 'function',
})
  .middleware([authWithOrganizationMiddleware])
  .validator(zodValidator(z.looseObject({ organizationId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    await requireOrganizationOwnerAccess(context.user.id, data.organizationId);

    return next({
      context: {
        organizationId: data.organizationId,
        scopedDb:
          data.organizationId === context.organizationId
            ? context.scopedDb
            : createScopedDb(data.organizationId, context.user.id),
      },
    });
  });
