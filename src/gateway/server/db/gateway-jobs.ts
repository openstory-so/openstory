/**
 * Scoped `gateway_jobs` rows (docs/architecture/model-gateway.md). Every
 * method is bound to one organization; another organization's job reads as missing.
 * A run may still write a job its submit marked `NOT_STARTED`: the trigger
 * can throw after the instance was created.
 */

import { inFillOrder, type ChargeLineKind } from '@/billing/charge-lines';
import { type Microdollars, micros } from '@/billing/money';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  gatewayJobs,
  type GatewayJob,
} from '@/platform/server/db/schema';
import type { MediaVia } from '@/models/via';
import type {
  GatewayJobError,
  GatewayJobInput,
  GatewayJobKind,
  GatewayJobOutput,
} from '@/gateway/schema';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';

const LIVE = ['queued', 'running'] as const;

/** A line of a job's charge, as its payer sees it. */
export type GatewayJobChargeLine = {
  kind: ChargeLineKind;
  amountMicros: Microdollars;
};

/** Live, or failed only because the trigger threw: the run may still land. */
const RUN_MAY_WRITE = or(
  inArray(gatewayJobs.status, LIVE),
  and(
    eq(gatewayJobs.status, 'failed'),
    sql`json_extract(${gatewayJobs.error}, '$.code') = 'NOT_STARTED'`
  )
);

/** Live jobs with a run, untouched since `before`, oldest first: the cron sweep's input, across organizations. */
export async function listStaleGatewayJobs(
  db: Database,
  before: Date,
  limit: number
): Promise<
  {
    id: string;
    organizationId: string;
    userId: string;
    runId: string;
    reservationId: string | null;
  }[]
> {
  const rows = await db
    .select({
      id: gatewayJobs.id,
      organizationId: gatewayJobs.organizationId,
      userId: gatewayJobs.userId,
      runId: gatewayJobs.workflowRunId,
      reservationId: gatewayJobs.reservationId,
    })
    .from(gatewayJobs)
    .where(
      and(
        inArray(gatewayJobs.status, LIVE),
        isNotNull(gatewayJobs.workflowRunId),
        lt(gatewayJobs.updatedAt, before)
      )
    )
    .orderBy(asc(gatewayJobs.updatedAt))
    .limit(limit);
  return rows.flatMap((row) =>
    row.runId ? [{ ...row, runId: row.runId }] : []
  );
}

export function createGatewayJobsMethods(
  db: Database,
  organizationId: string,
  userId: string
) {
  const own = (id: string) =>
    and(eq(gatewayJobs.id, id), eq(gatewayJobs.organizationId, organizationId));

  async function getById(id: string): Promise<GatewayJob | null> {
    const [row] = await db.select().from(gatewayJobs).where(own(id)).limit(1);
    return row ?? null;
  }

  async function getByIdempotencyKey(key: string): Promise<GatewayJob | null> {
    const [row] = await db
      .select()
      .from(gatewayJobs)
      .where(
        and(
          eq(gatewayJobs.organizationId, organizationId),
          eq(gatewayJobs.idempotencyKey, key)
        )
      )
      .limit(1);
    return row ?? null;
  }

  const jobLines = (id: string) =>
    and(
      eq(chargeLines.organizationId, organizationId),
      eq(chargeLines.gatewayJobId, id)
    );
  const linesSum = (id: string) =>
    sql<number>`(select sum(${chargeLines.amountMicros}) from ${chargeLines} where ${jobLines(id)})`;
  const hasLines = (id: string) =>
    exists(
      db.select({ id: chargeLines.id }).from(chargeLines).where(jobLines(id))
    );

  return {
    getById,
    getByIdempotencyKey,

    /** The lines of the job's charge this organization paid; empty until it settled. */
    getChargeLines: async (id: string): Promise<GatewayJobChargeLine[]> => {
      const rows = await db
        .select({
          kind: chargeLines.kind,
          amountMicros: chargeLines.amountMicros,
        })
        .from(chargeLines)
        .where(jobLines(id));
      return inFillOrder(
        rows.map((row) => ({ ...row, amountMicros: micros(row.amountMicros) }))
      );
    },

    /** Insert a queued job; a taken idempotency key returns its job with `created: false`. */
    create: async (job: {
      kind: GatewayJobKind;
      /** The provider's own model id. */
      modelKey: string;
      via: MediaVia;
      input: GatewayJobInput;
      idempotencyKey: string | null;
      oauthClientId: string | null;
    }): Promise<{ job: GatewayJob; created: boolean }> => {
      const [row] = await db
        .insert(gatewayJobs)
        .values({ organizationId, userId, ...job })
        .onConflictDoNothing()
        .returning();
      if (row) return { job: row, created: true };
      const existing = job.idempotencyKey
        ? await getByIdempotencyKey(job.idempotencyKey)
        : null;
      if (!existing) throw new Error('gateway job insert returned no row');
      return { job: existing, created: false };
    },

    /** Drop a job that never got a hold, so a replay of its key starts over. */
    deleteUnstarted: async (id: string): Promise<void> => {
      await db
        .delete(gatewayJobs)
        .where(
          and(
            own(id),
            eq(gatewayJobs.status, 'queued'),
            isNull(gatewayJobs.workflowRunId)
          )
        );
    },

    attachRun: async (
      id: string,
      run: { reservationId: string | null; workflowRunId: string }
    ): Promise<void> => {
      await db
        .update(gatewayJobs)
        .set({ ...run, updatedAt: new Date() })
        .where(own(id));
    },

    markRunning: async (id: string): Promise<void> => {
      await db
        .update(gatewayJobs)
        .set({
          status: 'running',
          error: null,
          completedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(own(id), RUN_MAY_WRITE, sql`${gatewayJobs.status} <> 'running'`)
        );
    },

    /** The provider's id for a queued job: a record, the run polls its own submission. */
    stampProviderJob: async (
      id: string,
      stamp: { via: MediaVia; providerJobId: string }
    ): Promise<void> => {
      await db
        .update(gatewayJobs)
        .set({ ...stamp, updatedAt: new Date() })
        .where(and(own(id), RUN_MAY_WRITE));
    },

    /** The stored results, before the charge, so a charged job always has them. */
    recordOutputs: async (
      id: string,
      result: { outputs: GatewayJobOutput[]; via: MediaVia }
    ): Promise<void> => {
      await db
        .update(gatewayJobs)
        .set({ ...result, updatedAt: new Date() })
        .where(and(own(id), RUN_MAY_WRITE));
    },

    markSucceeded: async (
      id: string,
      result: { outputs: GatewayJobOutput[]; costMicros: number; via: MediaVia }
    ): Promise<void> => {
      const now = new Date();
      await db.batch([
        db
          .update(gatewayJobs)
          .set({
            ...result,
            status: 'succeeded',
            error: null,
            updatedAt: now,
            completedAt: now,
          })
          .where(and(own(id), RUN_MAY_WRITE)),
        // A settle re-run after the success can debit what the first attempt could not.
        db
          .update(gatewayJobs)
          .set({ costMicros: linesSum(id), updatedAt: now })
          .where(
            and(own(id), eq(gatewayJobs.status, 'succeeded'), hasLines(id))
          ),
      ]);
    },

    /**
     * Fails a job, unless it was charged: a job with charge lines and stored
     * outputs ends `succeeded` at what its lines sum to, whatever failed after.
     * True when it changed the row.
     */
    markFailed: async (
      id: string,
      error: GatewayJobError
    ): Promise<boolean> => {
      const now = new Date();
      const [promoted, failed] = await db.batch([
        db
          .update(gatewayJobs)
          .set({
            status: 'succeeded',
            error: null,
            costMicros: linesSum(id),
            updatedAt: now,
            completedAt: now,
          })
          .where(
            and(
              own(id),
              RUN_MAY_WRITE,
              isNotNull(gatewayJobs.outputs),
              hasLines(id)
            )
          )
          .returning({ id: gatewayJobs.id }),
        db
          .update(gatewayJobs)
          .set({
            status: 'failed',
            error,
            updatedAt: now,
            completedAt: now,
          })
          .where(and(own(id), RUN_MAY_WRITE))
          .returning({ id: gatewayJobs.id }),
      ]);
      return promoted.length + failed.length > 0;
    },
  };
}
