/**
 * Scoped `gateway_jobs` rows (docs/architecture/model-gateway.md). Every
 * method is bound to one organization; another organization's job reads as
 * missing. API reads and idempotency are also bound to the caller's client.
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
  GatewayJobOutput,
} from '@/gateway/schema';
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
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

  /** The caller's key space: its OAuth client's, or the organization's own (null). */
  const callerKeySpace = (oauthClientId: string | null) =>
    sql`coalesce(${gatewayJobs.oauthClientId}, '') = ${oauthClientId ?? ''}`;

  /**
   * A job as an API caller may read it: an OAuth client sees only its own
   * jobs; an `osk_` key or a session (null) sees the organization's.
   */
  async function getForCaller(
    id: string,
    oauthClientId: string | null
  ): Promise<GatewayJob | null> {
    const [row] = await db
      .select()
      .from(gatewayJobs)
      .where(
        and(
          own(id),
          oauthClientId === null
            ? undefined
            : eq(gatewayJobs.oauthClientId, oauthClientId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /** The job a caller's `Idempotency-Key` made, in that caller's own key space. */
  async function getByIdempotencyKey(
    key: string,
    oauthClientId: string | null
  ): Promise<GatewayJob | null> {
    const [row] = await db
      .select()
      .from(gatewayJobs)
      .where(
        and(
          eq(gatewayJobs.organizationId, organizationId),
          callerKeySpace(oauthClientId),
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
    getForCaller,
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
    create: async (input: {
      input: GatewayJobInput;
      idempotencyKey: string | null;
      oauthClientId: string | null;
    }): Promise<{ job: GatewayJob; created: boolean }> => {
      const [row] = await db
        .insert(gatewayJobs)
        .values({
          organizationId,
          userId,
          kind: input.input.kind,
          modelKey: input.input.model,
          input: input.input,
          idempotencyKey: input.idempotencyKey,
          oauthClientId: input.oauthClientId,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return { job: row, created: true };
      const existing = input.idempotencyKey
        ? await getByIdempotencyKey(input.idempotencyKey, input.oauthClientId)
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

    /** The via and provider id a video job was sent to; poll follows this stamp. */
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
     */
    markFailed: async (
      id: string,
      error: GatewayJobError,
      via?: MediaVia
    ): Promise<void> => {
      const now = new Date();
      await db.batch([
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
          ),
        db
          .update(gatewayJobs)
          .set({
            status: 'failed',
            error,
            ...(via && { via }),
            updatedAt: now,
            completedAt: now,
          })
          .where(and(own(id), RUN_MAY_WRITE)),
      ]);
    },
  };
}
