import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
/**
 * Scoped Character Sheet Variants Sub-module
 * Append-only sheet versions plus mid-flight divergence parking.
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import type {
  CharacterSheetVariant,
  NewCharacterSheetVariant,
} from '@/platform/server/db/schema';
import {
  characterBibleVersions,
  characterLooks,
  characterSheetVariants,
  characters,
} from '@/platform/server/db/schema';
import { characterBibleColumns } from './bible-versions';
import { liveLookSheetVersionId, requireLook } from './character-looks';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { pageOf } from '@/platform/server/db/read-page';
import type { VersionListOptions } from '@/platform/server/db/read-page';
import { insertDivergentRaceTolerant } from '@/platform/server/db/scoped/divergent-insert';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';
import type { CharacterSheetInputHash } from '@/shots/input-hash';
import { landCharacterSheet } from './sheet-claims';

/**
 * The sheets of one look (#2015). A row with no `lookId` is one an older
 * worker wrote mid-deploy: a sheet of its character's default look, whose id
 * is the character's.
 */
const ofLook = (lookId: string) =>
  or(
    eq(characterSheetVariants.lookId, lookId),
    and(
      isNull(characterSheetVariants.lookId),
      eq(characterSheetVariants.characterId, lookId)
    )
  );

export function createCharacterSheetVariantsMethods(db: Database) {
  return {
    /** Every attempt (any status), oldest-first; discarded rows on request. */
    listByLook: async (
      lookId: string,
      options?: VersionListOptions
    ): Promise<CharacterSheetVariant[]> => {
      return await pageOf(
        db.select().from(characterSheetVariants).$dynamic(),
        and(
          ofLook(lookId),
          options?.includeDiscarded
            ? undefined
            : isNull(characterSheetVariants.discardedAt)
        ),
        characterSheetVariants.id,
        options?.page,
        asc(characterSheetVariants.id)
      );
    },

    /**
     * Selectable history: completed, not discarded, oldest-first so a
     * left-to-right strip can label v1, v2, … from position (same as
     * frame / video versions). Includes parked divergent rows so the user
     * can pick one instead of promoting through the banner.
     */
    listHistoryByLook: async (
      lookId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            ofLook(lookId),
            eq(characterSheetVariants.status, 'completed'),
            isNull(characterSheetVariants.discardedAt)
          )
        )
        .orderBy(
          asc(characterSheetVariants.createdAt),
          asc(characterSheetVariants.id)
        );
    },

    listDivergentByCharacter: async (
      characterId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            eq(characterSheetVariants.characterId, characterId),
            sql`${characterSheetVariants.divergedAt} IS NOT NULL`
          )
        );
    },

    /**
     * List active (non-discarded) divergent alternates for a character. The
     * UI banner / corner-dot reads through this so the surfaces clear once
     * the user discards or promotes.
     */
    listDivergentActiveByCharacter: async (
      characterId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            eq(characterSheetVariants.characterId, characterId),
            sql`${characterSheetVariants.divergedAt} IS NOT NULL`,
            sql`${characterSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(characterSheetVariants.divergedAt);
    },

    listDivergentActiveByCharacters: async (
      characterIds: string[]
    ): Promise<CharacterSheetVariant[]> => {
      if (characterIds.length === 0) return [];
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            inArray(characterSheetVariants.characterId, characterIds),
            sql`${characterSheetVariants.divergedAt} IS NOT NULL`,
            sql`${characterSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(characterSheetVariants.divergedAt);
    },

    /**
     * Look up a variant by id. Used by the promote / discard server functions
     * to confirm the row exists and is still divergent before acting.
     */
    /** Batch lookup, chunked below D1's 100-bound-parameter cap. */
    getByIds: async (
      variantIds: string[]
    ): Promise<CharacterSheetVariant[]> => {
      const rows: CharacterSheetVariant[] = [];
      for (let i = 0; i < variantIds.length; i += 80)
        rows.push(
          ...(await db
            .select()
            .from(characterSheetVariants)
            .where(
              inArray(characterSheetVariants.id, variantIds.slice(i, i + 80))
            ))
        );
      return rows;
    },

    getById: async (
      variantId: string
    ): Promise<CharacterSheetVariant | null> => {
      const result = await db
        .select()
        .from(characterSheetVariants)
        .where(eq(characterSheetVariants.id, variantId));
      return result[0] ?? null;
    },

    /**
     * Append a completed version and make it the live primary. Does not
     * discard anything, and no longer mirrors url / path / hash onto the
     * parent — reads resolve those from the pointer (#1419).
     *
     * The old pre-versioning snapshot branch is gone with them: it existed to
     * capture an image that lived only in the mirror columns, and the #1419
     * backfill gave every such row a version of its own.
     */
    applyConvergent: async (args: {
      /** The look the sheet is of (#2015). */
      lookId: string;
      url: string;
      storagePath: string;
      /** Verify-mirrored current-inputs hash on the version row. */
      inputHash: CharacterSheetInputHash | null;
      model: string;
      workflowRunId?: string | null;
    }): Promise<{ version: CharacterSheetVariant }> => {
      const { lookId, url, storagePath, inputHash, model, workflowRunId } =
        args;
      const look = await requireLook(db, lookId);

      const now = new Date();
      const [version] = await db
        .insert(characterSheetVariants)
        .values({
          id: generateId(),
          characterId: look.characterId,
          lookId,
          model,
          url,
          storagePath,
          status: 'completed',
          workflowRunId: workflowRunId ?? null,
          generatedAt: now,
          inputHash,
        })
        .returning();
      if (!version) {
        throw new Error('Failed to insert character sheet version');
      }

      await db
        .update(characterLooks)
        .set({
          sheetStatus: 'completed',
          sheetError: null,
          selectedSheetVersionId: version.id,
          // An unclaimed write picks the sheet: it demotes a run's claim.
          pendingPromoteSheetVersionId: null,
          updatedAt: now,
        })
        .where(eq(characterLooks.id, lookId));
      return { version };
    },

    /**
     * Repoint a look's live sheet at one of its completed versions — the look
     * is the version's own (#2015). Only moves the pointer — reads resolve
     * url / path / hash from the version it names (#1419). A divergent row
     * is unmarked so the banner clears. Previous pointer is recorded on the
     * event for undo.
     */
    select: async (
      characterId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<CharacterSheetVariant> => {
      const [version] = await db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            eq(characterSheetVariants.id, versionId),
            eq(characterSheetVariants.characterId, characterId)
          )
        );
      if (!version) {
        throw new NotFoundError(
          `CharacterSheetVariant ${versionId} not found for character ${characterId}`
        );
      }
      if (version.status !== 'completed' || !version.url) {
        throw new ValidationError(
          `CharacterSheetVariant ${versionId} is '${version.status}', not a completed image`
        );
      }
      if (version.discardedAt) {
        throw new ValidationError(
          `CharacterSheetVariant ${versionId} is discarded — restore it first`
        );
      }

      const look = await requireLook(db, version.lookId ?? characterId);
      const [existing] = await db
        .select({
          sequenceId: characters.sequenceId,
          name: characterBibleColumns.name,
        })
        .from(characters)
        .leftJoin(
          characterBibleVersions,
          eq(characterBibleVersions.id, characters.selectedBibleVersionId)
        )
        .where(eq(characters.id, characterId));
      if (!existing) {
        throw new Error(`Character ${characterId} not found`);
      }

      const now = new Date();
      await db.batch([
        db
          .update(characterLooks)
          .set({
            sheetStatus: 'completed',
            sheetError: null,
            selectedSheetVersionId: version.id,
            // The user's pick wins over an in-flight run (#1113).
            pendingPromoteSheetVersionId: null,
            updatedAt: now,
          })
          .where(eq(characterLooks.id, look.id)),
        db
          .update(characterSheetVariants)
          .set({ divergedAt: null, updatedAt: now })
          .where(eq(characterSheetVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'sheet.selected',
          targetType: 'character',
          targetId: characterId,
          summary: `Selected sheet version for ${existing.name}`,
          data: {
            prevState: {
              selectedSheetVersionId: look.selectedSheetVersionId,
            },
            lookId: look.id,
            versionId,
          },
        }),
      ]);
      return { ...version, divergedAt: null };
    },

    /**
     * A sheet run's completion (#1113): append its row under the claimed id
     * and select it only while the claim still names it; otherwise park it
     * as divergent. See {@link landCharacterSheet}.
     */
    promoteIfPending: async (
      args: Parameters<typeof landCharacterSheet>[1]
    ) => {
      await requireLook(db, args.lookId);
      return await landCharacterSheet(db, args);
    },

    insert: async (
      values: NewCharacterSheetVariant
    ): Promise<CharacterSheetVariant> => {
      const [row] = await db
        .insert(characterSheetVariants)
        .values(values)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!row) {
        throw new Error('Failed to insert character sheet variant');
      }
      return row;
    },

    /**
     * Idempotent on (lookId, model, inputHash) within the divergent
     * partial unique index. Tolerant to two failure modes:
     *
     *  - Step retry: the row was inserted on a previous attempt, the
     *    pre-check returns it.
     *  - Cross-run race: two divergent runs both pass the pre-check, one
     *    INSERT loses; the helper re-fetches and returns the winner's row.
     *
     * Pre-check + retry-fetch is required because drizzle's SQLite
     * `onConflictDoNothing` does not emit the partial-index `WHERE` predicate
     * after the target column list, so SQLite does not match the divergent
     * partial unique index and the conflict raises instead of being absorbed.
     */
    insertDivergent: async (
      values: NewCharacterSheetVariant & {
        lookId: string;
        inputHash: CharacterSheetInputHash;
        divergedAt: Date;
      }
    ): Promise<CharacterSheetVariant> => {
      const findExisting = () =>
        db
          .select()
          .from(characterSheetVariants)
          .where(
            and(
              eq(characterSheetVariants.lookId, values.lookId),
              eq(characterSheetVariants.model, values.model),
              eq(characterSheetVariants.inputHash, values.inputHash),
              sql`${characterSheetVariants.divergedAt} IS NOT NULL`
            )
          );
      return insertDivergentRaceTolerant({
        findExisting,
        insert: () =>
          db.insert(characterSheetVariants).values(values).returning(),
        errorMessage: 'Failed to insert character sheet variant',
      });
    },

    /**
     * Soft-delete a divergent alternate; preserves the row for the toast Undo.
     * A look's live sheet (its pointer, or a default look's pre-#1419 row
     * keyed to the character's own id) is refused: select another version
     * first.
     */
    discard: async (variantId: string): Promise<Date> => {
      const [live] = await db
        .select({ id: characterLooks.id })
        .from(characterLooks)
        .where(eq(liveLookSheetVersionId, variantId));
      if (live) {
        throw new ConflictError(
          'Cannot discard the selected sheet version; select another first.'
        );
      }
      const discardedAt = new Date();
      const result = await db
        .update(characterSheetVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(characterSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`CharacterSheetVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    undiscard: async (variantId: string): Promise<void> => {
      const result = await db
        .update(characterSheetVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(characterSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`CharacterSheetVariant ${variantId} not found`);
      }
    },
  };
}
