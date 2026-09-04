/**
 * Scoped sequence_exports CRUD. Exports are flat — no primary/divergent
 * split — and rows accumulate. Theatre reuse is hash-matched on
 * `sourceShotsHash`, not "newest ready".
 *
 * Two producers write here:
 * - the browser export pipeline (see `src/lib/sequence-player/export.ts`),
 *   which commits a finished `ready` row directly; and
 * - the server-side (API) export workflow, which `createProcessing()`s a row
 *   up front and later flips it to `ready`/`failed`.
 *
 * `listBySequence` is `ready`-only so the download UI never offers an
 * in-flight or failed server export; the API uses `listAllBySequence` to
 * surface progress.
 */

import type { Database } from '@/lib/db/client';
import {
  sequenceExports,
  type NewSequenceExport,
  type SequenceExport,
} from '@/lib/db/schema';
import { isUniqueConstraintError } from '@/lib/db/scoped/divergent-insert';
import { and, desc, eq } from 'drizzle-orm';

export function createSequenceExportsMethods(db: Database) {
  return {
    /** Newest-first list of every *ready* export for `sequenceId` (UI). */
    listBySequence: async (sequenceId: string): Promise<SequenceExport[]> => {
      return await db
        .select()
        .from(sequenceExports)
        .where(
          and(
            eq(sequenceExports.sequenceId, sequenceId),
            eq(sequenceExports.status, 'ready')
          )
        )
        .orderBy(desc(sequenceExports.createdAt));
    },

    /** Newest-first list of exports in any status (API — includes progress). */
    listAllBySequence: async (
      sequenceId: string
    ): Promise<SequenceExport[]> => {
      return await db
        .select()
        .from(sequenceExports)
        .where(eq(sequenceExports.sequenceId, sequenceId))
        .orderBy(desc(sequenceExports.createdAt));
    },

    getById: async (id: string): Promise<SequenceExport | null> => {
      const rows = await db
        .select()
        .from(sequenceExports)
        .where(eq(sequenceExports.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    insert: async (input: NewSequenceExport): Promise<SequenceExport> => {
      const [row] = await db.insert(sequenceExports).values(input).returning();
      if (!row) throw new Error('Failed to insert sequence export');
      return row;
    },

    /**
     * Reserve the (single) `processing` row for a server-side export run.
     *
     * Race-tolerant against concurrent POSTs: the `uq_sequence_exports_one_
     * processing` partial unique index allows only one in-flight row per
     * sequence, so a losing INSERT raises a unique-constraint error. We absorb
     * it and return the winning row with `created: false` — the caller then
     * coalesces onto it instead of triggering a second workflow. A pre-existing
     * stale row must be transitioned out of `processing` (markFailed) before
     * calling this, or the insert will always lose to it.
     */
    createProcessing: async (input: {
      sequenceId: string;
      url: string;
      storagePath: string;
      sourceShotsHash: string;
      workflowRunId?: string | null;
    }): Promise<{ row: SequenceExport; created: boolean }> => {
      try {
        const [row] = await db
          .insert(sequenceExports)
          .values({ ...input, status: 'processing' })
          .returning();
        if (!row) throw new Error('Failed to create sequence export');
        return { row, created: true };
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const [existing] = await db
          .select()
          .from(sequenceExports)
          .where(
            and(
              eq(sequenceExports.sequenceId, input.sequenceId),
              eq(sequenceExports.status, 'processing')
            )
          )
          .orderBy(desc(sequenceExports.createdAt))
          .limit(1);
        // Conflict on a different constraint than the one-processing index →
        // genuine error, rethrow.
        if (!existing) throw err;
        return { row: existing, created: false };
      }
    },

    markReady: async (
      id: string,
      fields: { durationSeconds?: number | null }
    ): Promise<void> => {
      await db
        .update(sequenceExports)
        .set({
          status: 'ready',
          error: null,
          durationSeconds: fields.durationSeconds ?? null,
        })
        .where(eq(sequenceExports.id, id));
    },

    markFailed: async (id: string, error: string): Promise<void> => {
      await db
        .update(sequenceExports)
        .set({ status: 'failed', error })
        .where(eq(sequenceExports.id, id));
    },

    setWorkflowRunId: async (
      id: string,
      workflowRunId: string
    ): Promise<void> => {
      await db
        .update(sequenceExports)
        .set({ workflowRunId })
        .where(eq(sequenceExports.id, id));
    },
  };
}
