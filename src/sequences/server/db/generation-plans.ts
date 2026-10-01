/**
 * Agent generation plans and their operations (#1460), team-scoped. The row
 * moves `planned` → `executing` once, by a guarded UPDATE, which is what makes
 * execute replay-safe; see the schema header.
 */

import type { Database } from '@/platform/server/db/client';
import {
  generationPlans,
  type GenerationPlanRow,
} from '@/platform/server/db/schema';
import { and, eq, lt, sql } from 'drizzle-orm';

export function createGenerationPlansMethods(db: Database, teamId: string) {
  const own = (id: string) =>
    and(eq(generationPlans.id, id), eq(generationPlans.teamId, teamId));
  return {
    create: async (
      row: Omit<
        typeof generationPlans.$inferInsert,
        'teamId' | 'status' | 'workflowRunIds' | 'error' | 'executedAt'
      >
    ): Promise<GenerationPlanRow> => {
      const [inserted] = await db
        .insert(generationPlans)
        .values({ ...row, teamId })
        .returning();
      if (!inserted) throw new Error('Failed to insert generation plan');
      return inserted;
    },

    getById: async (id: string): Promise<GenerationPlanRow | null> => {
      const [row] = await db.select().from(generationPlans).where(own(id));
      return row ?? null;
    },

    /** The one `planned` → `executing` step; null when another call took it. */
    claimExecution: async (id: string): Promise<GenerationPlanRow | null> => {
      const [row] = await db
        .update(generationPlans)
        .set({ status: 'executing', executedAt: new Date() })
        .where(and(own(id), eq(generationPlans.status, 'planned')))
        .returning();
      return row ?? null;
    },

    /**
     * Retake an `executing` row whose dispatch was lost (claimed before
     * `before`, nothing launched); null when another call retook it.
     */
    reclaimLostDispatch: async (
      id: string,
      before: Date
    ): Promise<GenerationPlanRow | null> => {
      const [row] = await db
        .update(generationPlans)
        .set({ executedAt: new Date() })
        .where(
          and(
            own(id),
            eq(generationPlans.status, 'executing'),
            lt(generationPlans.executedAt, before),
            eq(generationPlans.workflowRunIds, [])
          )
        )
        .returning();
      return row ?? null;
    },

    /** Record one launched run as soon as it starts. */
    addRun: async (id: string, workflowRunId: string): Promise<void> => {
      await db
        .update(generationPlans)
        .set({
          workflowRunIds: sql`json_insert(${generationPlans.workflowRunIds}, '$[#]', ${workflowRunId})`,
        })
        .where(and(own(id), eq(generationPlans.status, 'executing')));
    },

    markLaunched: async (id: string): Promise<void> => {
      await db
        .update(generationPlans)
        .set({ status: 'launched' })
        .where(and(own(id), eq(generationPlans.status, 'executing')));
    },

    markDispatchFailed: async (id: string, error: string): Promise<void> => {
      await db
        .update(generationPlans)
        .set({ status: 'dispatch_failed', error })
        .where(and(own(id), eq(generationPlans.status, 'executing')));
    },
  };
}
