/**
 * Scoped Shot Variants Sub-module
 * CRUD operations for per-model generation outputs on shots.
 */

import type { Database } from '@/platform/server/db/client';
import type { ShotVariant, NewShotVariant } from '@/platform/server/db/schema';
import type { ShotImageInputHash } from '@/shots/input-hash';
import { shotVariants } from '@/platform/server/db/schema';
import type { VariantType } from '@/platform/server/db/schema/shot-variants';
import { and, eq, sql } from 'drizzle-orm';

export function createShotVariantsMethods(db: Database) {
  return {
    getByShotAndModel: async (
      shotId: string,
      variantType: VariantType,
      model: string
    ): Promise<ShotVariant | null> => {
      // Scoped to the primary row (divergedAt IS NULL). Without this filter the
      // partial-index split lets divergent alternates share the (shot, type,
      // model) triple, so a bare select would non-deterministically return
      // either the primary or one of the alternates.
      const result = await db
        .select()
        .from(shotVariants)
        .where(
          and(
            eq(shotVariants.shotId, shotId),
            eq(shotVariants.variantType, variantType),
            eq(shotVariants.model, model),
            sql`${shotVariants.divergedAt} IS NULL`
          )
        );
      return result[0] ?? null;
    },

    listByShot: async (
      shotId: string,
      variantType?: VariantType
    ): Promise<ShotVariant[]> => {
      const conditions = [eq(shotVariants.shotId, shotId)];
      if (variantType) {
        conditions.push(eq(shotVariants.variantType, variantType));
      }
      return db
        .select()
        .from(shotVariants)
        .where(and(...conditions));
    },

    listBySequence: async (
      sequenceId: string,
      variantType: VariantType
    ): Promise<ShotVariant[]> => {
      return db
        .select()
        .from(shotVariants)
        .where(
          and(
            eq(shotVariants.sequenceId, sequenceId),
            eq(shotVariants.variantType, variantType)
          )
        );
    },

    listModelsForSequence: async (
      sequenceId: string,
      variantType: VariantType
    ): Promise<string[]> => {
      const result = await db
        .selectDistinct({ model: shotVariants.model })
        .from(shotVariants)
        .where(
          and(
            eq(shotVariants.sequenceId, sequenceId),
            eq(shotVariants.variantType, variantType)
          )
        );
      return result.map((r) => r.model);
    },

    upsert: async (data: NewShotVariant): Promise<ShotVariant> => {
      const [variant] = await db
        .insert(shotVariants)
        .values(data)
        .onConflictDoUpdate({
          target: [
            shotVariants.shotId,
            shotVariants.variantType,
            shotVariants.model,
          ],
          // Targets the primary partial unique index; divergent alternates
          // (divergedAt IS NOT NULL) sit in a separate index and are never
          // touched by upsert.
          targetWhere: sql`${shotVariants.divergedAt} IS NULL`,
          set: {
            url: sql.raw(`excluded."url"`),
            storagePath: sql.raw(`excluded."storage_path"`),
            status: sql.raw(`excluded."status"`),
            workflowRunId: sql.raw(`excluded."workflow_run_id"`),
            generatedAt: sql.raw(`excluded."generated_at"`),
            error: sql.raw(`excluded."error"`),
            promptHash: sql.raw(`excluded."prompt_hash"`),
            durationMs: sql.raw(`excluded."duration_ms"`),
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!variant) {
        throw new Error(
          `Failed to upsert ShotVariant for shot ${data.shotId} (${data.variantType}/${data.model})`
        );
      }
      return variant;
    },

    update: async (
      variantId: string,
      data: Partial<NewShotVariant>
    ): Promise<ShotVariant> => {
      const result = await db
        .update(shotVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(shotVariants.id, variantId))
        .returning();
      const variant = result.at(0);
      if (!variant) {
        throw new Error(`ShotVariant ${variantId} not found`);
      }
      return variant;
    },

    updateByShotAndModel: async (
      shotId: string,
      variantType: VariantType,
      model: string,
      data: Partial<NewShotVariant>
    ): Promise<ShotVariant | null> => {
      // Scoped to the primary row (divergedAt IS NULL) so divergent alternates
      // sharing the same (shot, type, model) triple are never overwritten.
      const result = await db
        .update(shotVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(
          and(
            eq(shotVariants.shotId, shotId),
            eq(shotVariants.variantType, variantType),
            eq(shotVariants.model, model),
            sql`${shotVariants.divergedAt} IS NULL`
          )
        )
        .returning();
      return result.at(0) ?? null;
    },

    /**
     * Insert a divergent alternate row. Idempotent on (shot, type, model,
     * inputHash) within the divergent partial unique index so retries
     * of the same reconcile step don't collide on a row already inserted on a
     * previous attempt. Returns the existing row on retry so callers can
     * reference its id.
     *
     * Pre-checks existence rather than `onConflictDoNothing` because drizzle's
     * SQLite `onConflictDoNothing` does not emit the partial-index `WHERE`
     * predicate after the target column list — without it SQLite cannot match
     * the divergent partial unique index, and the conflict raises instead of
     * being absorbed.
     */
    insertDivergent: async (
      data: NewShotVariant & {
        inputHash: ShotImageInputHash;
        divergedAt: Date;
      }
    ): Promise<ShotVariant> => {
      const existing = await db
        .select()
        .from(shotVariants)
        .where(
          and(
            eq(shotVariants.shotId, data.shotId),
            eq(shotVariants.variantType, data.variantType),
            eq(shotVariants.model, data.model),
            eq(shotVariants.inputHash, data.inputHash),
            sql`${shotVariants.divergedAt} IS NOT NULL`
          )
        );
      const existingRow = existing[0];
      if (existingRow) {
        return existingRow;
      }
      const [variant] = await db.insert(shotVariants).values(data).returning();
      if (!variant) {
        throw new Error(
          `Failed to insert divergent ShotVariant for shot ${data.shotId} (${data.variantType}/${data.model})`
        );
      }
      return variant;
    },

    isStale: async (
      variantId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: shotVariants.inputHash })
        .from(shotVariants)
        .where(eq(shotVariants.id, variantId));
      const row = result[0];
      if (!row) {
        throw new Error(`ShotVariant ${variantId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    /**
     * List divergent alternates for a shot (or all shots in a sequence) that
     * have not been discarded. Ordered oldest-first by divergedAt so the UI
     * surfaces the longest-pending alternate consistently.
     */
    listDivergentByShot: async (
      shotId: string,
      variantType?: VariantType
    ): Promise<ShotVariant[]> => {
      const conditions = [
        eq(shotVariants.shotId, shotId),
        sql`${shotVariants.divergedAt} IS NOT NULL`,
        sql`${shotVariants.discardedAt} IS NULL`,
      ];
      if (variantType) {
        conditions.push(eq(shotVariants.variantType, variantType));
      }
      return db
        .select()
        .from(shotVariants)
        .where(and(...conditions))
        .orderBy(shotVariants.divergedAt);
    },

    listDivergentBySequence: async (
      sequenceId: string
    ): Promise<ShotVariant[]> => {
      return db
        .select()
        .from(shotVariants)
        .where(
          and(
            eq(shotVariants.sequenceId, sequenceId),
            sql`${shotVariants.divergedAt} IS NOT NULL`,
            sql`${shotVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(shotVariants.divergedAt);
    },

    /**
     * Mark a divergent alternate as discarded. Idempotent; returns the
     * timestamp set so the caller can stash it for an Undo action.
     */
    discard: async (variantId: string): Promise<Date> => {
      const discardedAt = new Date();
      const result = await db
        .update(shotVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(shotVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`ShotVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    /**
     * Undo a previous discard by clearing discardedAt. Used by the sonner
     * toast Undo action.
     */
    undiscard: async (variantId: string): Promise<void> => {
      const result = await db
        .update(shotVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(shotVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`ShotVariant ${variantId} not found`);
      }
    },

    /**
     * Look up a divergent variant by id. Used by the promote/discard server
     * functions to confirm the row exists and is still divergent before
     * acting.
     */
    getById: async (variantId: string): Promise<ShotVariant | null> => {
      const result = await db
        .select()
        .from(shotVariants)
        .where(eq(shotVariants.id, variantId));
      return result[0] ?? null;
    },

    deleteByShot: async (shotId: string): Promise<number> => {
      const result = await db
        .delete(shotVariants)
        .where(eq(shotVariants.shotId, shotId));
      return result.rowsAffected;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(shotVariants)
        .where(eq(shotVariants.sequenceId, sequenceId));
      return result.rowsAffected;
    },
  };
}
