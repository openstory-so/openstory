/**
 * Moderation server functions — admin only (#1180).
 *
 * The violation-handling half of the platform-operator obligations: triage
 * reports, trace content back to the account that made it, act, and record what
 * was done. Every function here is behind `systemAdminMiddleware`, so the whole
 * surface is unreachable without an `ADMIN_EMAILS` match.
 */

import { systemAdminMiddleware } from './middleware';
import {
  CONTENT_REPORT_REASONS,
  CONTENT_REPORT_STATUSES,
  ENFORCEMENT_ACTIONS,
} from '@/lib/db/schema/compliance';
import { extractStorageKey, parseTraceId } from '@/lib/compliance/provenance';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { ValidationError } from '@/lib/errors';
import { getLogger } from '@/lib/observability/logger';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const logger = getLogger(['openstory', 'compliance', 'moderation']);

// ============================================================================
// Report queue
// ============================================================================

export const listContentReportsFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        statuses: z.array(z.enum(CONTENT_REPORT_STATUSES)).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const [reports, counts] = await Promise.all([
      context.adminScopedDb.moderation.listReports(data),
      context.adminScopedDb.moderation.countReportsByStatus(),
    ]);
    return { reports, counts };
  });

export const resolveContentReportFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        reportId: ulidSchema,
        status: z.enum(['triaged', 'actioned', 'dismissed']),
        resolutionNotes: z.string().max(5000).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await context.adminScopedDb.moderation.resolveReport({
      reportId: data.reportId,
      status: data.status,
      handledByUserId: context.user.id,
      resolutionNotes: data.resolutionNotes ?? null,
    });
    logger.info('report {reportId} resolved as {status}', {
      reportId: data.reportId,
      status: data.status,
      handledBy: context.user.id,
    });
    return { ok: true };
  });

/** Attach the resolved owner of the reported content to the report. */
export const attributeContentReportFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        reportId: ulidSchema,
        subjectTeamId: ulidSchema.optional(),
        subjectUserId: z.string().max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await context.adminScopedDb.moderation.attributeReport({
      reportId: data.reportId,
      subjectTeamId: data.subjectTeamId ?? null,
      subjectUserId: data.subjectUserId ?? null,
    });
    return { ok: true };
  });

// ============================================================================
// Trace — "here is a file, who made it?"
// ============================================================================

/**
 * Resolve an asset to the account that produced it.
 *
 * Takes whatever a complainant supplied. A pasted URL is reduced to its R2 key
 * because that is what provenance stores: the same object is reachable through
 * an origin-relative path, the CDN domain, and a signed URL, and matching on the
 * key makes all three resolve.
 */
export const traceContentFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        /** Trace id (`OS-…`), R2 key, asset URL, content hash, or request id. */
        query: z.string().min(3).max(1000),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const raw = data.query.trim();

    const provenanceId = parseTraceId(raw);
    const storageKey = extractStorageKey(raw);
    const contentSha256 = /^[0-9a-f]{64}$/i.test(raw)
      ? raw.toLowerCase()
      : null;

    const results = await context.adminScopedDb.moderation.findProvenance({
      provenanceId,
      storageKey,
      contentSha256,
      // Anything that isn't recognizably one of the above is still worth trying
      // as a provider request id — fal ids have no fixed shape we can match on.
      providerRequestId:
        provenanceId || storageKey || contentSha256 ? null : raw,
    });

    return { results };
  });

/** Everything an account generated — evidence for an enforcement decision. */
export const listTeamProvenanceFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        teamId: ulidSchema,
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const [provenance, attestations] = await Promise.all([
      context.adminScopedDb.moderation.listProvenanceForTeam(data.teamId, {
        limit: data.limit,
      }),
      context.adminScopedDb.moderation.listAttestationsForTeam(data.teamId, {
        limit: data.limit,
      }),
    ]);
    return { provenance, attestations };
  });

// ============================================================================
// Enforcement
// ============================================================================

export const applyEnforcementFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        subjectUserId: z.string().max(200).optional(),
        subjectTeamId: ulidSchema.optional(),
        action: z.enum(ENFORCEMENT_ACTIONS),
        reason: z.enum(CONTENT_REPORT_REASONS),
        notes: z.string().max(5000).optional(),
        reportId: ulidSchema.optional(),
        /** Timed suspension, in days. Omit for indefinite. */
        expiresInDays: z.number().int().min(1).max(3650).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!data.subjectUserId && !data.subjectTeamId) {
      throw new ValidationError(
        'An enforcement action needs a subject user or team'
      );
    }

    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    const action = await context.adminScopedDb.moderation.applyEnforcement({
      subjectUserId: data.subjectUserId ?? null,
      subjectTeamId: data.subjectTeamId ?? null,
      action: data.action,
      reason: data.reason,
      notes: data.notes ?? null,
      reportId: data.reportId ?? null,
      actorUserId: context.user.id,
      expiresAt,
    });

    // At `warn`, with the actor: enforcement is the most consequential thing
    // this admin surface can do, and it should be reconstructable from logs
    // alone even if the table is later disputed.
    logger.warn('enforcement applied: {action} for {reason}', {
      enforcementId: action.id,
      action: data.action,
      reason: data.reason,
      subjectUserId: data.subjectUserId,
      subjectTeamId: data.subjectTeamId,
      actorUserId: context.user.id,
      expiresAt,
    });

    return action;
  });

export const revokeEnforcementFn = createServerFn({ method: 'POST' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        enforcementId: ulidSchema,
        revokedReason: z.string().max(500).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    await context.adminScopedDb.moderation.revokeEnforcement({
      enforcementId: data.enforcementId,
      revokedByUserId: context.user.id,
      revokedReason: data.revokedReason ?? null,
    });
    logger.warn('enforcement {enforcementId} revoked', {
      enforcementId: data.enforcementId,
      actorUserId: context.user.id,
    });
    return { ok: true };
  });

export const listEnforcementFn = createServerFn({ method: 'GET' })
  .middleware([systemAdminMiddleware])
  .validator(
    zodValidator(
      z.object({
        subjectUserId: z.string().max(200).optional(),
        subjectTeamId: ulidSchema.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    return context.adminScopedDb.moderation.listEnforcement(data);
  });
