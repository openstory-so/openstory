/**
 * Server Function Middleware
 * Reusable middleware for authentication, team access, and resource validation
 */

import { scheduleFlushAnalytics } from '#flush-scheduler';
import {
  requireTeamAdminAccess,
  requireTeamMemberAccess,
  requireTeamOwnerAccess,
} from '@/lib/auth/action-utils';
import type { Session, User } from '@/lib/auth/config';
import { getAuth } from '@/lib/auth/config';
import { isSystemAdmin, requireSystemAdmin } from '@/lib/auth/system-admin';
import { APIError } from 'better-auth/api';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Resolution } from '@/lib/constants/resolutions';
import {
  createScopedDb,
  createSystemAdminScopedDb,
  getSequenceByIdUnscoped,
  resolveUserTeam,
  type ScopedDb,
} from '@/lib/db/scoped';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { resolveSceneForShotFromDb } from '@/lib/scenes/scene-script';
import {
  assertCanWrite,
  restrictionNotice,
} from '@/lib/compliance/enforcement';
import { loadComplianceState } from '@/lib/compliance/generation-gate';
import {
  AccountRestrictedError,
  AuthenticationError,
  NotFoundError,
} from '@/lib/errors';
import {
  errorHeadline,
  getLogger,
  toErrorPayload,
} from '@/lib/observability/logger';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import type { Frame } from '@/lib/db/schema';
import type { SequenceStatus } from '@/lib/db/schema/sequences';
import type { Shot, Sequence } from '@/types/database';
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

export type TeamContext = AuthContext & {
  teamId: string;
  scopedDb: ScopedDb;
};

export type SystemAdminContext = TeamContext;

export type SequenceContext = TeamContext & {
  sequence: Sequence;
};

/**
 * Partial sequence type returned by getShotWithSequence
 * Contains only the fields selected by the query
 */
type PartialSequence = {
  id: string;
  teamId: string;
  title: string;
  /** Narrow, not `string`: staleness defers while the sequence is
   * 'processing' (#1121), and that check must not be a string compare. */
  status: SequenceStatus;
  styleId: string | null;
  imageModel: string;
  videoModel: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  analysisModel: string;
  /** Sequence default for the start-frame mode; see `usesStartFrame()`. */
  generateStartFrames: boolean;
};

export type ShotContext = TeamContext & {
  shot: Omit<Shot, 'sequence'>;
  frame: Frame;
  sequence: PartialSequence;
  /** Scene metadata with the selected script version overlaid (#1030). */
  scene: Scene | null;
  /** Selected scene script content, when available. */
  script: Scene['originalScript'] | null;
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
const EXPECTED_REJECTION_CODES = new Set([
  'INSUFFICIENT_CREDITS',
  'VALIDATION_ERROR',
  'NOT_FOUND',
]);
const serverFnLogger = getLogger(['openstory', 'serverFn']);
const apiAuthLogger = getLogger(['openstory', 'api', 'auth']);

/**
 * JSON error envelope for request-middleware rejections, matching the
 * `/api/v1` `{ error: { code, message } }` contract. Programmatic callers parse
 * this; a plain-text 401/403 would crash their JSON parser.
 */
function authErrorResponse(
  status: number,
  code: string,
  message: string
): Response {
  return Response.json({ error: { code, message } }, { status });
}

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
      // NOT `statusCode < 500` — a status range would also silence 401 spikes
      // (an auth incident) and anything a handler mislabels as a 4xx.
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
// Auth Middleware
// ============================================================================

/**
 * Resolve the session for a request. The apiKey plugin validates a key header
 * inside `getSession` and *throws* an APIError rather than returning null:
 *   - a 429 (key over its per-key rate limit) is surfaced as a JSON 429 with a
 *     `Retry-After` header (programmatic callers need this);
 *   - a genuine auth rejection (disabled/expired/unknown key → 401/403) is
 *     treated as unauthenticated → null (the caller turns that into a 401);
 *   - anything else (D1 down, auth-backend 5xx, programmer error) is logged and
 *     surfaced as a JSON 500. It must NOT be flattened to a 401 "bad key": that
 *     tells a caller with a perfectly valid key to rotate/abandon it, and hides
 *     the real incident.
 */
async function resolveRequestSession(request: Request) {
  const auth = getAuth();
  try {
    return await auth.api.getSession({ headers: request.headers });
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 429) {
      const tryAgainInMs = error.body?.details?.tryAgainIn;
      const retryAfter =
        typeof tryAgainInMs === 'number' ? Math.ceil(tryAgainInMs / 1000) : 1;
      throw Response.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'API key rate limit exceeded. Retry shortly.',
          },
        },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }
    if (
      error instanceof APIError &&
      (error.statusCode === 401 || error.statusCode === 403)
    ) {
      return null;
    }
    apiAuthLogger.error('session resolution failed: {message}', {
      message: error instanceof Error ? error.message : String(error),
      err: toErrorPayload(error),
    });
    throw authErrorResponse(
      500,
      'INTERNAL_ERROR',
      'Authentication could not be processed. Please retry.'
    );
  }
}

/**
 * Request auth middleware — for use with server routes (server.middleware).
 * Unlike authMiddleware (type: 'function'), this is request-scoped and
 * receives the request object directly from the middleware params.
 */
export const authRequestMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const session = await resolveRequestSession(request);

    if (!session?.user) {
      throw authErrorResponse(
        401,
        'UNAUTHORIZED',
        'Valid authentication required. Provide an API key via "Authorization: Bearer <key>" or "x-api-key".'
      );
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
 * Request auth + team middleware — for use with server routes (server.middleware).
 * Authenticates user, resolves their default team, and creates a scoped DB.
 * Throws 401 if no user, 403 if no team, 429 if a key is over its rate limit.
 */
export const authWithTeamRequestMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    // Server ROUTES don't get `analyticsFlushMiddleware` — that one is
    // `type: 'function'`, so it only composes into server functions. Without
    // a flush here, a product event captured by a route handler (e.g.
    // `sequence_generated` from the public v1 create endpoint) races isolate
    // teardown: `captureProductEvent` is fire-and-forget, and on Workers an
    // in-flight fetch is cancelled once the response is returned.
    try {
      const session = await resolveRequestSession(request);

      if (!session?.user) {
        throw authErrorResponse(
          401,
          'UNAUTHORIZED',
          'Valid authentication required. Provide an API key via "Authorization: Bearer <key>" or "x-api-key".'
        );
      }

      const team = await resolveUserTeam(session.user.id);

      if (!team) {
        throw authErrorResponse(
          403,
          'NO_TEAM',
          'No team is associated with this account.'
        );
      }

      const compliance = await loadComplianceState(
        session.user.id,
        team.teamId
      );
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
          user: session.user,
          session,
          teamId: team.teamId,
          scopedDb: createScopedDb(team.teamId, session.user.id),
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
 * Auth with default team context
 * Automatically resolves user's default team
 */
export const authWithTeamMiddleware = createMiddleware({ type: 'function' })
  .middleware([analyticsFlushMiddleware])
  .server(async ({ next, context }) => {
    const team = await resolveUserTeam(context.user.id);

    if (!team) {
      throw new Error('No team found for user');
    }

    const compliance = await loadComplianceState(context.user.id, team.teamId);
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
    const request = getRequest();
    if (request.method !== 'GET') {
      assertCanWrite(compliance.enforcement);
    }

    return next({
      context: {
        teamId: team.teamId,
        scopedDb: createScopedDb(team.teamId, context.user.id),
      },
    });
  });

// ============================================================================
// System Admin Middleware
// ============================================================================

/**
 * System admin middleware - requires ADMIN_EMAILS env var match
 * Extends authWithTeamMiddleware so context includes teamId
 */
export const systemAdminMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
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
 * Loads sequence and verifies team access
 * Requires sequenceId in input data
 */
export const sequenceAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.looseObject({ sequenceId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    let sequence = await context.scopedDb.sequences.getById(data.sequenceId);
    let { teamId, scopedDb } = context;

    if (!sequence && isSystemAdmin(context.user.email)) {
      sequence = await getSequenceByIdUnscoped(data.sequenceId);
      if (sequence) {
        teamId = sequence.teamId;
        scopedDb = createScopedDb(sequence.teamId, context.user.id);
      }
    }

    if (!sequence) {
      throw new NotFoundError('Sequence not found');
    }

    return next({
      context: {
        sequence,
        teamId,
        scopedDb,
      },
    });
  });

/**
 * Shot access middleware
 * Loads shot with its sequence and verifies team access
 * Requires sequenceId and shotId in input data
 */
export const shotAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(z.looseObject({ sequenceId: ulidSchema, shotId: ulidSchema }))
  )
  .server(async ({ next, context, data }) => {
    const shotData = await context.scopedDb.shots.getWithSequence(data.shotId);

    if (!shotData || shotData.sequenceId !== data.sequenceId) {
      throw new NotFoundError('Shot not found in this sequence');
    }

    let { teamId, scopedDb } = context;

    if (shotData.sequence.teamId !== context.teamId) {
      if (!isSystemAdmin(context.user.email)) {
        throw new NotFoundError('Shot not found in this sequence');
      }
      teamId = shotData.sequence.teamId;
      scopedDb = createScopedDb(shotData.sequence.teamId, context.user.id);
    }

    // Extract sequence from shot data (using the partial sequence from the query)
    const { sequence: rawSequence, ...shot } = shotData;

    // Anchor frame (#989) — the shot's IMAGE surface (was the shots.thumbnail*
    // columns): its first frame (orderIndex 0), resolved by shotId, never by
    // id-reuse. Every shot owns one (created at shot-create / backfilled by the
    // Phase 2 migration); create it defensively if a legacy shot predates it.
    let frame = await scopedDb.frames.getAnchorByShot(shot.id);
    if (!frame) {
      await scopedDb.shots.ensureAnchorFrames([shot]);
      frame = await scopedDb.frames.getAnchorByShot(shot.id);
    }
    if (!frame) {
      throw new NotFoundError('Shot is missing its anchor frame');
    }

    // Type assertion needed because Drizzle's nested relation inference loses the $type<AspectRatio>() annotation
    const sequence: PartialSequence = {
      ...rawSequence,
      aspectRatio: rawSequence.aspectRatio satisfies AspectRatio,
      resolution: rawSequence.resolution satisfies Resolution,
    };

    const { scene, script } = await resolveSceneForShotFromDb(shot, scopedDb);

    return next({
      context: {
        shot,
        frame,
        sequence,
        scene,
        script,
        teamId,
        scopedDb,
      },
    });
  });

/**
 * Team member access middleware
 * Verifies user has access to the specified team
 * Requires teamId in input data
 */
export const teamMemberAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.looseObject({ teamId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    if (data.teamId !== context.teamId) {
      await requireTeamMemberAccess(context.user.id, data.teamId);
    }

    return next({
      context: {
        teamId: data.teamId,
        scopedDb:
          data.teamId === context.teamId
            ? context.scopedDb
            : createScopedDb(data.teamId, context.user.id),
      },
    });
  });

/**
 * Team admin access middleware
 * Verifies user has admin access to the specified team
 * Requires teamId in input data
 */
export const teamAdminAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.looseObject({ teamId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    await requireTeamAdminAccess(context.user.id, data.teamId);

    return next({
      context: {
        teamId: data.teamId,
        scopedDb:
          data.teamId === context.teamId
            ? context.scopedDb
            : createScopedDb(data.teamId, context.user.id),
      },
    });
  });

/**
 * Team owner access middleware
 * Verifies user has owner access to the specified team
 * Requires teamId in input data
 */
export const teamOwnerAccessMiddleware = createMiddleware({ type: 'function' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.looseObject({ teamId: ulidSchema })))
  .server(async ({ next, context, data }) => {
    await requireTeamOwnerAccess(context.user.id, data.teamId);

    return next({
      context: {
        teamId: data.teamId,
        scopedDb:
          data.teamId === context.teamId
            ? context.scopedDb
            : createScopedDb(data.teamId, context.user.id),
      },
    });
  });
