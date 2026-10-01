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
import { and, eq } from 'drizzle-orm';

export function createGenerationPlansMethods(db: Database, teamId: string) {
  const own = (id: string) =>
    and(eq(generationPlans.id, id), eq(generationPlans.teamId, teamId));
  return {
    create: async (
      row: Omit<
        typeof generationPlans.$inferInsert,
        'teamId' | 'status' | 'workflowRunId' | 'error' | 'executedAt'
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

    markLaunched: async (id: string, workflowRunId: string): Promise<void> => {
      await db
        .update(generationPlans)
        .set({ status: 'launched', workflowRunId })
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
