/**
 * Scoped Compliance Sub-module (#1180).
 *
 * Three factories, split by who is allowed to call them:
 *
 *  - `createComplianceMethods(db, organizationId, userId)` — organization-scoped. What a normal
 *    request may do: record provenance for its own generations, attest to its
 *    own uploads, file a report.
 *  - `createComplianceReadMethods(db)` — unscoped enforcement reads for the
 *    request path. Not organization-scoped because enforcement follows the person, and
 *    the gate has to work before we know which organization they are acting for.
 *  - `createModerationMethods(db)` — cross-organization, admin only. The triage queue,
 *    enforcement, and trace lookup. Reached via `createSystemAdminScopedDb`,
 *    so an organization-scoped caller cannot get at it.
 *
 * Method naming matters here: the workflow write surface
 * (`src/platform/server/db/scoped-workflow.ts`) strips anything whose name starts with
 * get/list/find/latest/current/resolve/by/has. `provenance.record` is
 * write-shaped, so workflows get it automatically; the read methods below are
 * stripped from workflows by construction, which is what we want — provenance
 * is written during a run and read only from server functions.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  contentProvenance,
  contentReports,
  enforcementActions,
  uploadAttestations,
} from '@/platform/server/db/schema/compliance';
import type {
  ContentReport,
  ContentReportReason,
  ContentReportStatus,
  ContentReportTargetType,
  EnforcementAction,
  EnforcementActionType,
  NewContentProvenance,
  UploadAttestation,
  AttestationSubjectType,
} from '@/platform/server/db/schema/compliance';
import { organization, user } from '@/platform/server/db/schema';
import { ValidationError } from '@/platform/errors';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

/** Reports that jump the queue: nothing else outranks CSAM. */
const FORCED_TOP_PRIORITY: readonly ContentReportReason[] = ['csam'];
const TOP_PRIORITY = 0;
const DEFAULT_PRIORITY = 50;

/**
 * Priority a report enters the queue with. Reporter-supplied severity is not
 * trusted — only the reason category is — because the field a bad actor would
 * game to bury their own report is exactly the one we would be trusting.
 */
function intakePriority(reason: ContentReportReason): number {
  return FORCED_TOP_PRIORITY.includes(reason) ? TOP_PRIORITY : DEFAULT_PRIORITY;
}

// ============================================================================
// Organization-scoped
// ============================================================================

/**
 * Provenance writes — its own top-level scoped domain, deliberately.
 *
 * Workflows need this (they are what produces assets), and the workflow write
 * surface strips domains method-by-method at the TOP level only. Nesting
 * provenance under `compliance` alongside `attestations.listForSubject` would
 * carry those read methods into `WorkflowScopedDb` intact, re-opening the
 * mid-run-read hole that `scoped-workflow.ts` exists to close. A domain whose
 * every method is write-shaped cannot leak a read.
 */
export function createProvenanceMethods(
  db: Database,
  organizationId: string,
  userId: string
) {
  return {
    /**
     * Insert one provenance row. `organizationId` is injected from scope, but a row may
     * legitimately carry a different `userId` (a workflow triggered by one
     * member producing an asset in a shared organization), so the caller's value wins
     * when supplied.
     */
    async record(
      row: NewContentProvenance
    ): Promise<{ id: string } | undefined> {
      const [inserted] = await db
        .insert(contentProvenance)
        .values({
          ...row,
          id: row.id ?? generateId(),
          organizationId,
          userId: row.userId ?? userId,
        })
        .returning({ id: contentProvenance.id });
      return inserted;
    },
  };
}

export function createComplianceMethods(
  db: Database,
  organizationId: string,
  userId: string
) {
  return {
    attestations: {
      /** Record a rights attestation for an upload this organization just made. */
      async record(input: {
        subjectType: AttestationSubjectType;
        subjectId: string;
        statementVersion: string;
        statementSha256: string;
        depictsRealPerson: boolean;
        authorizationBasis?: string | null;
        ipAddress?: string | null;
        userAgent?: string | null;
      }): Promise<UploadAttestation> {
        const [inserted] = await db
          .insert(uploadAttestations)
          .values({
            id: generateId(),
            userId,
            organizationId,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            statementVersion: input.statementVersion,
            statementSha256: input.statementSha256,
            depictsRealPerson: input.depictsRealPerson,
            authorizationBasis: input.authorizationBasis ?? null,
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
          })
          .returning();
        if (!inserted) {
          throw new Error('attestations.record: insert returned nothing');
        }
        return inserted;
      },

      /** Attestations covering one upload, newest first. */
      async listForSubject(
        subjectType: AttestationSubjectType,
        subjectId: string
      ): Promise<UploadAttestation[]> {
        return (
          db
            .select()
            .from(uploadAttestations)
            .where(
              and(
                eq(uploadAttestations.organizationId, organizationId),
                eq(uploadAttestations.subjectType, subjectType),
                eq(uploadAttestations.subjectId, subjectId)
              )
            )
            // Image identity is the WHERE (`subjectType` + `subjectId`). Tied
            // seconds then follow the row's monotonic ULID so a sign-off in the
            // same second as its finding still wins (#1610).
            .orderBy(
              desc(uploadAttestations.attestedAt),
              desc(uploadAttestations.id)
            )
        );
      },

      /**
       * {@link listForSubject} for many uploads in one read (#2065), in the
       * same order, so the first row of each subject is its latest.
       */
      async listForSubjects(
        subjectType: AttestationSubjectType,
        subjectIds: string[]
      ): Promise<UploadAttestation[]> {
        const rows: UploadAttestation[] = [];
        // D1 binds at most 100 values a statement; two are the scope.
        for (let i = 0; i < subjectIds.length; i += 90) {
          rows.push(
            ...(await db
              .select()
              .from(uploadAttestations)
              .where(
                and(
                  eq(uploadAttestations.organizationId, organizationId),
                  eq(uploadAttestations.subjectType, subjectType),
                  inArray(
                    uploadAttestations.subjectId,
                    subjectIds.slice(i, i + 90)
                  )
                )
              )
              .orderBy(
                desc(uploadAttestations.attestedAt),
                desc(uploadAttestations.id)
              ))
          );
        }
        return rows;
      },
    },

    /**
     * Live enforcement rows for this user + organization. On the request path the
     * unscoped `createComplianceReadMethods` version is used (the gate may
     * run before an organization is resolved). Workflows reach this one through
     * `scopedDb.liveRead` as a spawn-time billing-guard analogue.
     */
    async listEnforcementFor(
      subjectUserId: string,
      subjectOrganizationId?: string | null
    ): Promise<EnforcementAction[]> {
      return createComplianceReadMethods(db).listEnforcementFor(
        subjectUserId,
        subjectOrganizationId
      );
    },

    reports: {
      /** File a report as a signed-in member of this organization. */
      async create(input: {
        targetType: ContentReportTargetType;
        targetId: string;
        reason: ContentReportReason;
        details?: string | null;
        traceId?: string | null;
      }): Promise<ContentReport> {
        return insertReport(db, {
          ...input,
          reporterUserId: userId,
          reporterEmail: null,
          ipAddress: null,
          userAgent: null,
        });
      },
    },
  };
}

// ============================================================================
// Unscoped reads for the request path
// ============================================================================

/**
 * Enforcement reads used by the generation gate.
 *
 * Not organization-scoped: an action against a person applies wherever they are acting,
 * and pretending otherwise would let a suspended user open a second organization and
 * carry on.
 */
export function createComplianceReadMethods(db: Database) {
  return {
    /**
     * Every enforcement action bearing on a user, including actions against the
     * organization they are acting for. Returns unrevoked rows only; expiry is resolved
     * in `resolveEnforcementState` so the caller controls "now".
     */
    async listEnforcementFor(
      subjectUserId: string,
      subjectOrganizationId?: string | null
    ): Promise<EnforcementAction[]> {
      const subjectMatch = subjectOrganizationId
        ? or(
            eq(enforcementActions.subjectUserId, subjectUserId),
            eq(enforcementActions.subjectOrganizationId, subjectOrganizationId)
          )
        : eq(enforcementActions.subjectUserId, subjectUserId);

      return db
        .select()
        .from(enforcementActions)
        .where(and(subjectMatch, isNull(enforcementActions.revokedAt)))
        .orderBy(desc(enforcementActions.createdAt));
    },
  };
}

/**
 * Insert a report. Shared by the authenticated and anonymous paths so intake
 * rules — forced priority for CSAM, in particular — cannot be bypassed by
 * filing through the public form.
 */
async function insertReport(
  db: Database,
  input: {
    targetType: ContentReportTargetType;
    targetId: string;
    reason: ContentReportReason;
    details?: string | null;
    traceId?: string | null;
    reporterUserId?: string | null;
    reporterEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }
): Promise<ContentReport> {
  const [inserted] = await db
    .insert(contentReports)
    .values({
      id: generateId(),
      reporterUserId: input.reporterUserId ?? null,
      reporterEmail: input.reporterEmail ?? null,
      targetType: input.targetType,
      targetId: input.targetId,
      traceId: input.traceId ?? null,
      reason: input.reason,
      details: input.details ?? null,
      status: 'open',
      priority: intakePriority(input.reason),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning();
  if (!inserted) {
    throw new Error('content report insert returned nothing');
  }
  return inserted;
}

/**
 * Public (unauthenticated) report intake.
 *
 * Deliberately reachable without a session: the person whose likeness was
 * misused is precisely the person who does not have an account, and a takedown
 * channel only open to paying customers is not a takedown channel. Exposed as
 * its own factory taking no scope at all, so this code path cannot express a
 * organization-scoped query even by accident.
 */
export function createPublicReportIntake(db: Database) {
  return {
    async submit(input: {
      targetType: ContentReportTargetType;
      targetId: string;
      reason: ContentReportReason;
      details?: string | null;
      traceId?: string | null;
      reporterEmail?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
    }): Promise<{ id: string; reason: ContentReportReason }> {
      const report = await insertReport(db, input);
      return { id: report.id, reason: report.reason };
    },
  };
}

// ============================================================================
// Admin / moderation (cross-organization)
// ============================================================================

export type ReportQueueRow = ContentReport & {
  subjectOrganizationName: string | null;
  subjectUserEmail: string | null;
  reporterUserEmail: string | null;
};

export type ProvenanceLookupRow = {
  id: string;
  traceId: string;
  assetKind: string;
  assetId: string;
  storageKey: string | null;
  contentSha256: string | null;
  provider: string;
  model: string;
  providerRequestId: string | null;
  workflowRunId: string | null;
  promptSha256: string | null;
  sequenceId: string | null;
  shotId: string | null;
  usedReferenceImages: boolean;
  referenceImageCount: number;
  createdAt: Date;
  organizationId: string;
  organizationName: string | null;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
};

export function createModerationMethods(db: Database) {
  // Three joins onto `user`/`organization` from one row, so each needs its own alias —
  // same pattern as the admin support queries.
  const reporterUser = alias(user, 'reporter_user');
  const subjectUser = alias(user, 'subject_user');
  const subjectOrganization = alias(organization, 'subject_organization');

  async function listReports(opts?: {
    statuses?: ContentReportStatus[];
    limit?: number;
  }): Promise<ReportQueueRow[]> {
    const { statuses, limit = 100 } = opts ?? {};

    const rows = await db
      .select({
        report: contentReports,
        subjectOrganizationName: subjectOrganization.name,
        subjectUserEmail: subjectUser.email,
        reporterUserEmail: reporterUser.email,
      })
      .from(contentReports)
      .leftJoin(
        reporterUser,
        eq(contentReports.reporterUserId, reporterUser.id)
      )
      .leftJoin(subjectUser, eq(contentReports.subjectUserId, subjectUser.id))
      .leftJoin(
        subjectOrganization,
        eq(contentReports.subjectOrganizationId, subjectOrganization.id)
      )
      .where(
        statuses?.length ? inArray(contentReports.status, statuses) : undefined
      )
      // Worst first, then oldest: a queue sorted only by time buries the CSAM
      // report that arrived this morning under yesterday's copyright complaints.
      .orderBy(asc(contentReports.priority), asc(contentReports.createdAt))
      .limit(limit);

    return rows.map(({ report, ...joined }) => ({ ...report, ...joined }));
  }

  /** Counts per status, for the queue header. */
  async function countReportsByStatus(): Promise<
    Record<ContentReportStatus, number>
  > {
    const rows = await db
      .select({
        status: contentReports.status,
        count: sql<number>`count(*)`,
      })
      .from(contentReports)
      .groupBy(contentReports.status);

    const counts: Record<ContentReportStatus, number> = {
      open: 0,
      triaged: 0,
      actioned: 0,
      dismissed: 0,
    };
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  /**
   * Attach the resolved owner of the reported content to the report, so the
   * queue can group by account and so the row still names the subject after the
   * content itself is gone.
   */
  async function attributeReport(input: {
    reportId: string;
    subjectOrganizationId?: string | null;
    subjectUserId?: string | null;
  }): Promise<void> {
    await db
      .update(contentReports)
      .set({
        subjectOrganizationId: input.subjectOrganizationId ?? null,
        subjectUserId: input.subjectUserId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(contentReports.id, input.reportId));
  }

  async function resolveReport(input: {
    reportId: string;
    status: Extract<ContentReportStatus, 'triaged' | 'actioned' | 'dismissed'>;
    handledByUserId: string;
    resolutionNotes?: string | null;
  }): Promise<void> {
    await db
      .update(contentReports)
      .set({
        status: input.status,
        handledByUserId: input.handledByUserId,
        handledAt: new Date(),
        resolutionNotes: input.resolutionNotes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(contentReports.id, input.reportId));
  }

  async function applyEnforcement(input: {
    subjectUserId?: string | null;
    subjectOrganizationId?: string | null;
    action: EnforcementActionType;
    reason: ContentReportReason;
    notes?: string | null;
    reportId?: string | null;
    actorUserId?: string | null;
    appliedBySystem?: string | null;
    expiresAt?: Date | null;
  }): Promise<EnforcementAction> {
    if (!input.subjectUserId && !input.subjectOrganizationId) {
      throw new ValidationError(
        'An enforcement action needs a subject user or organization'
      );
    }
    const [inserted] = await db
      .insert(enforcementActions)
      .values({
        id: generateId(),
        subjectUserId: input.subjectUserId ?? null,
        subjectOrganizationId: input.subjectOrganizationId ?? null,
        action: input.action,
        reason: input.reason,
        notes: input.notes ?? null,
        reportId: input.reportId ?? null,
        actorUserId: input.actorUserId ?? null,
        appliedBySystem: input.appliedBySystem ?? null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!inserted) {
      throw new Error('applyEnforcement: insert returned nothing');
    }
    return inserted;
  }

  async function revokeEnforcement(input: {
    enforcementId: string;
    revokedByUserId: string;
    revokedReason?: string | null;
  }): Promise<void> {
    await db
      .update(enforcementActions)
      .set({
        revokedAt: new Date(),
        revokedByUserId: input.revokedByUserId,
        revokedReason: input.revokedReason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(enforcementActions.id, input.enforcementId));
  }

  async function markEnforcementNotified(enforcementId: string): Promise<void> {
    await db
      .update(enforcementActions)
      .set({ notifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(enforcementActions.id, enforcementId));
  }

  async function listEnforcement(opts?: {
    subjectUserId?: string;
    subjectOrganizationId?: string;
    limit?: number;
  }): Promise<EnforcementAction[]> {
    const { subjectUserId, subjectOrganizationId, limit = 100 } = opts ?? {};
    const filters = [
      subjectUserId
        ? eq(enforcementActions.subjectUserId, subjectUserId)
        : undefined,
      subjectOrganizationId
        ? eq(enforcementActions.subjectOrganizationId, subjectOrganizationId)
        : undefined,
    ].filter((clause) => clause !== undefined);

    return db
      .select()
      .from(enforcementActions)
      .where(filters.length ? or(...filters) : undefined)
      .orderBy(desc(enforcementActions.createdAt))
      .limit(limit);
  }

  /**
   * Resolve an asset back to the account that produced it — the core trace
   * operation. Accepts whatever the complainant had: a trace id, an R2 key or
   * URL fragment, a content hash, or the provider's request id.
   */
  async function findProvenance(query: {
    provenanceId?: string | null;
    storageKey?: string | null;
    contentSha256?: string | null;
    providerRequestId?: string | null;
    limit?: number;
  }): Promise<ProvenanceLookupRow[]> {
    const filters = [
      query.provenanceId
        ? eq(contentProvenance.id, query.provenanceId)
        : undefined,
      query.storageKey
        ? eq(contentProvenance.storageKey, query.storageKey)
        : undefined,
      query.contentSha256
        ? eq(contentProvenance.contentSha256, query.contentSha256)
        : undefined,
      query.providerRequestId
        ? eq(contentProvenance.providerRequestId, query.providerRequestId)
        : undefined,
    ].filter((clause) => clause !== undefined);

    if (!filters.length) {
      throw new ValidationError('A provenance lookup needs at least one key');
    }

    const rows = await db
      .select({
        provenance: contentProvenance,
        organizationName: organization.name,
        userEmail: user.email,
        userName: user.name,
      })
      .from(contentProvenance)
      .leftJoin(
        organization,
        eq(contentProvenance.organizationId, organization.id)
      )
      .leftJoin(user, eq(contentProvenance.userId, user.id))
      .where(or(...filters))
      .orderBy(desc(contentProvenance.createdAt))
      .limit(query.limit ?? 20);

    return rows.map(
      ({ provenance, organizationName, userEmail, userName }) => ({
        ...provenance,
        traceId: `OS-${provenance.id}`,
        organizationName,
        userEmail,
        userName,
      })
    );
  }

  /** Everything an account generated in a window — enforcement evidence. */
  async function listProvenanceForOrganization(
    subjectOrganizationId: string,
    opts?: { limit?: number }
  ) {
    return db
      .select()
      .from(contentProvenance)
      .where(eq(contentProvenance.organizationId, subjectOrganizationId))
      .orderBy(desc(contentProvenance.createdAt))
      .limit(opts?.limit ?? 100);
  }

  /** Attestations an account made — the portrait-rights evidence trail. */
  async function listAttestationsForOrganization(
    subjectOrganizationId: string,
    opts?: { limit?: number }
  ): Promise<UploadAttestation[]> {
    return db
      .select()
      .from(uploadAttestations)
      .where(eq(uploadAttestations.organizationId, subjectOrganizationId))
      .orderBy(desc(uploadAttestations.attestedAt), desc(uploadAttestations.id))
      .limit(opts?.limit ?? 100);
  }

  return {
    listReports,
    countReportsByStatus,
    attributeReport,
    resolveReport,
    applyEnforcement,
    revokeEnforcement,
    markEnforcementNotified,
    listEnforcement,
    findProvenance,
    listProvenanceForOrganization,
    listAttestationsForOrganization,
  };
}
