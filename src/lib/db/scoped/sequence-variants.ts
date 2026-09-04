/**
 * Scoped Sequence Variants Sub-module
 * CRUD for sequence-level music variants. Promotion writes back to the matching
 * `sequences.*` columns so existing UI keeps reading those.
 *
 * Divergence routing: `writeMusicVariant` compares the incoming `inputHash`
 * against the existing primary (if any) and routes to `insertDivergentMusic`
 * when the hashes differ. This preserves the previous primary instead of
 * silently replacing it.
 */

import type { Database } from '@/lib/db/client';
import { sequenceMusicVariants, sequences } from '@/lib/db/schema';
import type {
  NewSequenceMusicVariant,
  Sequence,
  SequenceMusicVariant,
} from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { insertDivergentRaceTolerant } from './divergent-insert';

export type WriteVariantResult<T> = { variant: T; divergent: boolean };

export function createSequenceVariantsMethods(db: Database) {
  const getMusicPrimary = async (
    sequenceId: string,
    model: string
  ): Promise<SequenceMusicVariant | null> => {
    const result = await db
      .select()
      .from(sequenceMusicVariants)
      .where(
        and(
          eq(sequenceMusicVariants.sequenceId, sequenceId),
          eq(sequenceMusicVariants.model, model),
          sql`${sequenceMusicVariants.divergedAt} IS NULL`
        )
      );
    if (result.length > 1) {
      throw new Error(
        `[sequenceVariants] Multiple primary music variants found for sequence ${sequenceId} model ${model} — partial unique index violated`
      );
    }
    return result.at(0) ?? null;
  };

  const upsertMusicPrimary = async (
    data: NewSequenceMusicVariant
  ): Promise<SequenceMusicVariant> => {
    const result = await db
      .insert(sequenceMusicVariants)
      .values(data)
      .onConflictDoUpdate({
        target: [sequenceMusicVariants.sequenceId, sequenceMusicVariants.model],
        targetWhere: sql`${sequenceMusicVariants.divergedAt} IS NULL`,
        set: {
          url: sql.raw(`excluded."url"`),
          storagePath: sql.raw(`excluded."storage_path"`),
          prompt: sql.raw(`excluded."prompt"`),
          tags: sql.raw(`excluded."tags"`),
          durationSeconds: sql.raw(`excluded."duration_seconds"`),
          status: sql.raw(`excluded."status"`),
          workflowRunId: sql.raw(`excluded."workflow_run_id"`),
          generatedAt: sql.raw(`excluded."generated_at"`),
          error: sql.raw(`excluded."error"`),
          inputHash: sql.raw(`excluded."input_hash"`),
          updatedAt: new Date(),
        },
      })
      .returning();
    const variant = result.at(0);
    if (!variant) {
      throw new Error('upsertMusicPrimary returned no row');
    }
    return variant;
  };

  /**
   * Vacate a model's live primary slot by stamping `divergedAt`, so a fresh
   * row can take it while the old one survives as a promotable alternate
   * (#1108). Needed for user uploads: every upload shares the
   * `USER_UPLOAD_MODEL` slot, so `upsertMusicPrimary` would UPDATE the previous
   * upload's row in place and destroy the only pointer to those bytes —
   * versions are append-only, and product delete is never silent. Generated
   * tracks don't need this: each model owns its own slot.
   *
   * Returns the retired row, or null when the slot was already empty.
   */
  const retireMusicPrimary = async (
    sequenceId: string,
    model: string
  ): Promise<SequenceMusicVariant | null> => {
    const existing = await getMusicPrimary(sequenceId, model);
    if (!existing) return null;
    const now = new Date();
    const [retired] = await db
      .update(sequenceMusicVariants)
      .set({ divergedAt: now, updatedAt: now })
      .where(eq(sequenceMusicVariants.id, existing.id))
      .returning();
    return retired ?? null;
  };

  const insertDivergentMusic = async (
    data: NewSequenceMusicVariant & { inputHash: string; divergedAt: Date }
  ): Promise<SequenceMusicVariant> => {
    const findExisting = () =>
      db
        .select()
        .from(sequenceMusicVariants)
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, data.sequenceId),
            eq(sequenceMusicVariants.model, data.model),
            eq(sequenceMusicVariants.inputHash, data.inputHash),
            sql`${sequenceMusicVariants.divergedAt} IS NOT NULL`
          )
        );
    return insertDivergentRaceTolerant({
      findExisting,
      insert: () => db.insert(sequenceMusicVariants).values(data).returning(),
      errorMessage: 'insertDivergentMusic returned no row',
    });
  };

  return {
    // ── Music variants ────────────────────────────────────────────────────
    listMusicBySequence: async (
      sequenceId: string
    ): Promise<SequenceMusicVariant[]> => {
      return db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.sequenceId, sequenceId));
    },

    /**
     * Distinct audio models that have a primary (non-divergent) variant for
     * this sequence (#546). Drives the header audio-model dropdown.
     */
    listMusicModels: async (sequenceId: string): Promise<string[]> => {
      const result = await db
        .selectDistinct({ model: sequenceMusicVariants.model })
        .from(sequenceMusicVariants)
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, sequenceId),
            sql`${sequenceMusicVariants.divergedAt} IS NULL`
          )
        );
      return result.map((r) => r.model);
    },

    getMusicPrimary,
    upsertMusicPrimary,
    retireMusicPrimary,
    insertDivergentMusic,

    /**
     * Write a completed music variant. Routes to a divergent alternate when an
     * existing completed primary has a different `inputHash`. Otherwise upserts
     * the primary in place. Callers should skip live `sequences.music*` updates
     * when `divergent` is true.
     */
    writeMusicVariant: async (
      data: NewSequenceMusicVariant & { inputHash: string }
    ): Promise<WriteVariantResult<SequenceMusicVariant>> => {
      const existing = await getMusicPrimary(data.sequenceId, data.model);
      const isDivergent =
        existing !== null &&
        existing.status === 'completed' &&
        existing.inputHash !== null &&
        existing.inputHash !== data.inputHash;
      if (isDivergent) {
        const variant = await insertDivergentMusic({
          ...data,
          divergedAt: new Date(),
        });
        return { variant, divergent: true };
      }
      const variant = await upsertMusicPrimary(data);
      return { variant, divergent: false };
    },

    /**
     * Flip an EXISTING primary (non-divergent) music variant row to `failed`
     * (#547). Update-only: it never inserts — a primary model's first generation
     * has no pre-stamped row — and never overwrites a `completed` alternate.
     * Mirrors the image/motion `onFailure` variant write so an added audio model
     * whose generation fails leaves `pending` and becomes re-addable instead of
     * spinning `generating` forever.
     */
    markMusicFailed: async (
      sequenceId: string,
      model: string,
      error: string
    ): Promise<void> => {
      await db
        .update(sequenceMusicVariants)
        .set({ status: 'failed', error, updatedAt: new Date() })
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, sequenceId),
            eq(sequenceMusicVariants.model, model),
            sql`${sequenceMusicVariants.divergedAt} IS NULL`,
            sql`${sequenceMusicVariants.status} != 'completed'`
          )
        );
    },

    getMusicById: async (
      variantId: string
    ): Promise<SequenceMusicVariant | null> => {
      const result = await db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.id, variantId));
      return result.at(0) ?? null;
    },

    /**
     * Aggregate divergent music-variant counts across a team's sequences.
     * Powers the corner-dot indicator on the sequence dashboard — a single
     * round-trip keyed by `teamId` instead of N per-sequence calls.
     */
    listDivergentByTeam: async (
      teamId: string
    ): Promise<Array<{ sequenceId: string; hasMusic: boolean }>> => {
      const musicRows = await db
        .select({ sequenceId: sequenceMusicVariants.sequenceId })
        .from(sequenceMusicVariants)
        .innerJoin(
          sequences,
          eq(sequences.id, sequenceMusicVariants.sequenceId)
        )
        .where(
          and(
            eq(sequences.teamId, teamId),
            sql`${sequenceMusicVariants.divergedAt} IS NOT NULL`,
            sql`${sequenceMusicVariants.discardedAt} IS NULL`
          )
        );

      const byId = new Map<string, { sequenceId: string; hasMusic: boolean }>();
      for (const { sequenceId } of musicRows) {
        if (!byId.has(sequenceId)) {
          byId.set(sequenceId, { sequenceId, hasMusic: true });
        }
      }
      return [...byId.values()];
    },

    listDivergentMusic: async (
      sequenceId: string
    ): Promise<SequenceMusicVariant[]> => {
      return db
        .select()
        .from(sequenceMusicVariants)
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, sequenceId),
            sql`${sequenceMusicVariants.divergedAt} IS NOT NULL`,
            sql`${sequenceMusicVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(sequenceMusicVariants.divergedAt);
    },

    discardMusicVariant: async (variantId: string): Promise<Date> => {
      const discardedAt = new Date();
      const result = await db
        .update(sequenceMusicVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(sequenceMusicVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    undiscardMusicVariant: async (variantId: string): Promise<void> => {
      const result = await db
        .update(sequenceMusicVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(sequenceMusicVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      }
    },

    /**
     * Atomically promote a music variant: copies prompt/tags/url/path/model
     * onto the live `sequences.music*` columns AND soft-deletes the variant
     * row in a single libSQL batch.
     */
    promoteMusicVariant: async (
      variantId: string
    ): Promise<{ sequence: Sequence; discardedAt: Date }> => {
      const variantRows = await db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.id, variantId));
      const variant = variantRows.at(0);
      if (!variant) {
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      }
      const [existingSequence] = await db
        .select({ id: sequences.id })
        .from(sequences)
        .where(eq(sequences.id, variant.sequenceId));
      if (!existingSequence) {
        throw new Error(`Sequence ${variant.sequenceId} not found`);
      }

      const now = new Date();
      const updateSequence = db
        .update(sequences)
        .set({
          musicUrl: variant.url,
          musicPath: variant.storagePath,
          musicPrompt: variant.prompt,
          musicTags: variant.tags,
          musicModel: variant.model,
          musicStatus: 'completed',
          musicGeneratedAt: variant.generatedAt ?? now,
          musicError: null,
          updatedAt: now,
        })
        .where(eq(sequences.id, variant.sequenceId))
        .returning();
      const discardVariant = db
        .update(sequenceMusicVariants)
        .set({ discardedAt: now, updatedAt: now })
        .where(eq(sequenceMusicVariants.id, variantId))
        .returning();
      const [sequenceRows, variantRows2] = await db.batch([
        updateSequence,
        discardVariant,
      ]);
      const promotedSequence = sequenceRows[0];
      if (!promotedSequence) {
        throw new Error(
          `Sequence ${variant.sequenceId} disappeared during promote`
        );
      }
      if (variantRows2.length === 0) {
        throw new Error(
          `SequenceMusicVariant ${variantId} disappeared during promote`
        );
      }
      return { sequence: promotedSequence, discardedAt: now };
    },

    /**
     * Copy a model's completed variant onto the sequence's live primary
     * (`sequences.music*`) WITHOUT discarding the variant row — the
     * non-destructive "Set Music" used to switch which model's track is the
     * sequence primary (#546). Mirrors `setVideoFromVariant`. Contrast
     * `promoteMusicVariant`, which consumes a divergent alternate.
     */
    setMusicFromVariant: async (variantId: string): Promise<Sequence> => {
      const variantRows = await db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.id, variantId));
      const variant = variantRows.at(0);
      if (!variant) {
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      }
      const now = new Date();
      const [updated] = await db
        .update(sequences)
        .set({
          musicUrl: variant.url,
          musicPath: variant.storagePath,
          musicPrompt: variant.prompt,
          musicTags: variant.tags,
          musicModel: variant.model,
          musicStatus: 'completed',
          musicGeneratedAt: variant.generatedAt ?? now,
          musicError: null,
          updatedAt: now,
        })
        .where(eq(sequences.id, variant.sequenceId))
        .returning();
      if (!updated) {
        throw new Error(
          `Sequence ${variant.sequenceId} disappeared during set-music`
        );
      }
      return updated;
    },
  };
}
