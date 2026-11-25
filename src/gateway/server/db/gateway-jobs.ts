/**
 * Scoped `gateway_jobs` rows (docs/architecture/model-gateway.md). Every
 * method is bound to one organization; another organization's job reads as missing.
 */

import type { Database } from '@/platform/server/db/client';
import { gatewayJobs, type GatewayJob } from '@/platform/server/db/schema';
import type { MediaVia } from '@/models/via';
import type {
  GatewayJobError,
  GatewayJobInput,
  GatewayJobKind,
  GatewayJobOutput,
} from '@/gateway/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';

const LIVE = ['queued', 'running'] as const;

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

  return {
    getById,
    getByIdempotencyKey,

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
        .set({ status: 'running', updatedAt: new Date() })
        .where(and(own(id), eq(gatewayJobs.status, 'queued')));
    },

    /** The provider's id for a queued job: a record, the run polls its own submission. */
    stampProviderJob: async (
      id: string,
      stamp: { via: MediaVia; providerJobId: string }
    ): Promise<void> => {
      await db
        .update(gatewayJobs)
        .set({ ...stamp, updatedAt: new Date() })
        .where(and(own(id), inArray(gatewayJobs.status, LIVE)));
    },

    markSucceeded: async (
      id: string,
      result: { outputs: GatewayJobOutput[]; costMicros: number; via: MediaVia }
    ): Promise<void> => {
      const now = new Date();
      await db
        .update(gatewayJobs)
        .set({
          ...result,
          status: 'succeeded',
          error: null,
          updatedAt: now,
          completedAt: now,
        })
        .where(and(own(id), inArray(gatewayJobs.status, LIVE)));
    },

    markFailed: async (id: string, error: GatewayJobError): Promise<void> => {
      const now = new Date();
      await db
        .update(gatewayJobs)
        .set({
          status: 'failed',
          error,
          updatedAt: now,
          completedAt: now,
        })
        .where(and(own(id), inArray(gatewayJobs.status, LIVE)));
    },
  };
}
