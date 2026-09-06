/**
 * Scoped Talent Sheet Variants Sub-module
 * CRUD for divergent talent-sheet outputs (Stage 2 of workflow snapshots).
 */

import type { Database } from '@/lib/db/client';
import type {
  NewTalentSheetVariant,
  TalentSheetVariant,
} from '@/lib/db/schema';
import { talentSheetVariants, talentSheets } from '@/lib/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { insertDivergentRaceTolerant } from './divergent-insert';
import { assertTalentSheetWritableForTeam } from './talent';

type PromoteTalentSheetUpdate = {
  imageUrl: string | null;
  imagePath: string | null;
  inputHash: string | null;
};

export function createTalentSheetVariantsMethods(db: Database, teamId: string) {
  return {
    listByTalentSheet: async (
      talentSheetId: string
    ): Promise<TalentSheetVariant[]> => {
      return db
        .select()
        .from(talentSheetVariants)
        .where(eq(talentSheetVariants.talentSheetId, talentSheetId));
    },

    listDivergentByTalentSheet: async (
      talentSheetId: string
    ): Promise<TalentSheetVariant[]> => {
      return db
        .select()
        .from(talentSheetVariants)
        .where(
          and(
            eq(talentSheetVariants.talentSheetId, talentSheetId),
            sql`${talentSheetVariants.divergedAt} IS NOT NULL`
          )
        );
    },

    /**
     * Active (non-discarded) divergent alternates for a talent sheet. UI
     * banner / corner-dot read through this so the surfaces clear once the
     * user promotes or discards.
     */
    listDivergentActiveByTalentSheet: async (
      talentSheetId: string
    ): Promise<TalentSheetVariant[]> => {
      return db
        .select()
        .from(talentSheetVariants)
        .where(
          and(
            eq(talentSheetVariants.talentSheetId, talentSheetId),
            sql`${talentSheetVariants.divergedAt} IS NOT NULL`,
            sql`${talentSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(talentSheetVariants.divergedAt);
    },

    /**
     * Active divergent variants for any sheet belonging to one of the given
     * talent ids. Used to drive the corner-dot indicator on talent-library
     * cards without forcing the caller to first fetch every talent's sheets.
     */
    listDivergentActiveByTalents: async (
      talentIds: string[]
    ): Promise<TalentSheetVariant[]> => {
      if (talentIds.length === 0) return [];
      const sheets = await db
        .select({ id: talentSheets.id })
        .from(talentSheets)
        .where(inArray(talentSheets.talentId, talentIds));
      if (sheets.length === 0) return [];
      return db
        .select()
        .from(talentSheetVariants)
        .where(
          and(
            inArray(
              talentSheetVariants.talentSheetId,
              sheets.map((s) => s.id)
            ),
            sql`${talentSheetVariants.divergedAt} IS NOT NULL`,
            sql`${talentSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(talentSheetVariants.divergedAt);
    },

    listDivergentActiveByTalentSheets: async (
      talentSheetIds: string[]
    ): Promise<TalentSheetVariant[]> => {
      if (talentSheetIds.length === 0) return [];
      return db
        .select()
        .from(talentSheetVariants)
        .where(
          and(
            inArray(talentSheetVariants.talentSheetId, talentSheetIds),
            sql`${talentSheetVariants.divergedAt} IS NOT NULL`,
            sql`${talentSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(talentSheetVariants.divergedAt);
    },

    getById: async (variantId: string): Promise<TalentSheetVariant | null> => {
      const result = await db
        .select()
        .from(talentSheetVariants)
        .where(eq(talentSheetVariants.id, variantId));
      return result[0] ?? null;
    },

    insert: async (
      values: NewTalentSheetVariant
    ): Promise<TalentSheetVariant> => {
      await assertTalentSheetWritableForTeam(db, values.talentSheetId, teamId);

      const [row] = await db
        .insert(talentSheetVariants)
        .values(values)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!row) {
        throw new Error('Failed to insert talent sheet variant');
      }
      return row;
    },

    /**
     * Idempotent on (talentSheetId, model, inputHash) within the divergent
     * partial unique index. Tolerant to step retry and cross-run race;
     * see `divergent-insert.ts` for the rationale.
     */
    insertDivergent: async (
      values: NewTalentSheetVariant & {
        inputHash: string;
        divergedAt: Date;
      }
    ): Promise<TalentSheetVariant> => {
      await assertTalentSheetWritableForTeam(db, values.talentSheetId, teamId);

      const findExisting = () =>
        db
          .select()
          .from(talentSheetVariants)
          .where(
            and(
              eq(talentSheetVariants.talentSheetId, values.talentSheetId),
              eq(talentSheetVariants.model, values.model),
              eq(talentSheetVariants.inputHash, values.inputHash),
              sql`${talentSheetVariants.divergedAt} IS NOT NULL`
            )
          );
      return insertDivergentRaceTolerant({
        findExisting,
        insert: () => db.insert(talentSheetVariants).values(values).returning(),
        errorMessage: 'Failed to insert talent sheet variant',
      });
    },

    /** Soft-delete a divergent alternate; preserves the row for the toast Undo. */
    discard: async (variantId: string): Promise<Date> => {
      const variant = await db.query.talentSheetVariants.findFirst({
        where: { id: variantId },
      });
      if (!variant) {
        throw new Error(`TalentSheetVariant ${variantId} not found`);
      }
      await assertTalentSheetWritableForTeam(db, variant.talentSheetId, teamId);

      const discardedAt = new Date();
      const result = await db
        .update(talentSheetVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(talentSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`TalentSheetVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    undiscard: async (variantId: string): Promise<void> => {
      const variant = await db.query.talentSheetVariants.findFirst({
        where: { id: variantId },
      });
      if (!variant) {
        throw new Error(`TalentSheetVariant ${variantId} not found`);
      }
      await assertTalentSheetWritableForTeam(db, variant.talentSheetId, teamId);

      const result = await db
        .update(talentSheetVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(talentSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`TalentSheetVariant ${variantId} not found`);
      }
    },

    /**
     * Atomically copy variant fields onto the live `talent_sheets` row and
     * soft-delete the variant. Single batch so a partial failure cannot leave
     * the live primary updated with the variant still appearing as divergent.
     */
    promoteAtomically: async (
      talentSheetId: string,
      sheetUpdate: PromoteTalentSheetUpdate,
      variantId: string
    ): Promise<{ discardedAt: Date }> => {
      const [existingSheet] = await db
        .select({ id: talentSheets.id })
        .from(talentSheets)
        .where(eq(talentSheets.id, talentSheetId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!existingSheet) {
        throw new Error(`TalentSheet ${talentSheetId} not found`);
      }
      const [existingVariant] = await db
        .select({ id: talentSheetVariants.id })
        .from(talentSheetVariants)
        .where(eq(talentSheetVariants.id, variantId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!existingVariant) {
        throw new Error(`TalentSheetVariant ${variantId} not found`);
      }

      await assertTalentSheetWritableForTeam(db, talentSheetId, teamId);

      const now = new Date();
      const updateSheet = db
        .update(talentSheets)
        .set({ ...sheetUpdate, updatedAt: now })
        .where(eq(talentSheets.id, talentSheetId))
        .returning({ id: talentSheets.id });
      const discardVariant = db
        .update(talentSheetVariants)
        .set({ discardedAt: now, updatedAt: now })
        .where(eq(talentSheetVariants.id, variantId))
        .returning({ id: talentSheetVariants.id });
      const [sheetRows, variantRows] = await db.batch([
        updateSheet,
        discardVariant,
      ]);
      if (sheetRows.length === 0) {
        throw new Error(
          `TalentSheet ${talentSheetId} disappeared during promote`
        );
      }
      if (variantRows.length === 0) {
        throw new Error(
          `TalentSheetVariant ${variantId} disappeared during promote`
        );
      }
      return { discardedAt: now };
    },
  };
}
