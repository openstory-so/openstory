/**
 * Scoped Talent Sub-module
 *
 * A talent is a likeness (#2018): the row, its reference media and its sheet
 * history. The reference sheet is the `talent_sheets` row `selectedSheetId`
 * names; it moves only through `landSheet` (while the run's claim holds) and
 * `selectSheet` (the user). Other rows are history: parked (`divergedAt`),
 * discarded (`discardedAt`) or just older.
 */

import type { Database } from '@/platform/server/db/client';
import type {
  NewTalent,
  NewTalentMedia,
  NewTalentSheet,
  Talent,
  TalentMediaRecord,
  TalentSheet,
  TalentWithSheets,
} from '@/platform/server/db/schema';
import {
  characterBibleVersions,
  talent,
  talentMedia,
  talentSheets,
} from '@/platform/server/db/schema';
import type { TalentSheetInputHash } from '@/shots/input-hash';
import { ValidationError } from '@/platform/errors';
import { castOfTalent } from './sequence-cast';
import {
  demoteCharacterSheetClaims,
  demoteTalentSheetClaim,
} from './sheet-claims';
import {
  SERVER_MANAGED_TALENT_COLUMNS,
  type ServerManagedTalentColumn,
} from '@/cast/server/talent.schemas';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { stripServerManagedColumns } from '@/platform/server/db/scoped/server-managed';

const TALENT_WRITE_DENIED =
  'Talent not found or you do not have permission to modify it';

/** The sheet history is written only by `landSheet`; the constant fills the NOT NULL legacy column. */
const LEGACY_SHEET_NAME = 'Reference sheet';

/**
 * Write-side ACL for scoped talent mutations. Public/system templates are
 * readable by every team but writable only by non-public, team-owned rows.
 */
export function isTeamWritableTalent(
  record: { teamId: string; isPublic: boolean | null },
  teamId: string
): boolean {
  return record.teamId === teamId && !record.isPublic;
}

async function getWritableTalent(
  db: Database,
  talentId: string,
  teamId: string
): Promise<Talent | undefined> {
  const record = await db.query.talent.findFirst({
    where: { id: talentId },
  });
  if (!record || !isTeamWritableTalent(record, teamId)) {
    return undefined;
  }
  return record;
}

async function requireWritableTalent(
  db: Database,
  talentId: string,
  teamId: string
): Promise<Talent> {
  const record = await getWritableTalent(db, talentId, teamId);
  if (!record) {
    throw new Error(TALENT_WRITE_DENIED);
  }
  return record;
}

/** A sheet row, resolved to a talent this team may write. */
async function requireWritableSheet(
  db: Database,
  sheetId: string,
  teamId: string
): Promise<{ sheet: TalentSheet; talent: Talent }> {
  const sheet = await db.query.talentSheets.findFirst({
    where: { id: sheetId },
  });
  if (!sheet) throw new Error(`TalentSheet ${sheetId} not found`);
  return {
    sheet,
    talent: await requireWritableTalent(db, sheet.talentId, teamId),
  };
}

const sheetCount = sql<number>`(
  SELECT COUNT(*) FROM talent_sheets
  WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
)`
  .mapWith(Number)
  .as('sheet_count');

const parkedSheetId = sql<string | null>`(
  SELECT talent_sheets.id FROM talent_sheets
  WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
    AND talent_sheets.diverged_at IS NOT NULL
    AND talent_sheets.discarded_at IS NULL
  ORDER BY talent_sheets.diverged_at, talent_sheets.id
  LIMIT 1
)`.as('parked_sheet_id');

/**
 * Shared implementation for team-scoped and public (anonymous) talent reads.
 * A null teamId means public-only scope: every query filters on isPublic with
 * no team arm, so the anonymous code path cannot express a team-scoped query.
 */
function createTalentReadMethodsScoped(db: Database, teamId: string | null) {
  const scope =
    teamId === null
      ? eq(talent.isPublic, true)
      : or(eq(talent.teamId, teamId), eq(talent.isPublic, true));
  const queryScope =
    teamId === null
      ? { isPublic: true }
      : { OR: [{ teamId }, { isPublic: true }] };

  // The reference sheet is one join on the pointer: no Default scan, no
  // "newest convergent" fallback (#2018).
  const withReferenceSheet = (where: ReturnType<typeof and>) =>
    db
      .select({
        talent: talent,
        sheetCount,
        parkedSheetId,
        referenceSheet: talentSheets,
      })
      .from(talent)
      .leftJoin(talentSheets, eq(talentSheets.id, talent.selectedSheetId))
      .where(where);

  const toTalentWithSheets = (r: {
    talent: Talent;
    sheetCount: number;
    parkedSheetId: string | null;
    referenceSheet: TalentSheet | null;
  }): TalentWithSheets => ({
    ...r.talent,
    sheetCount: r.sheetCount,
    sheets: [],
    referenceSheet: r.referenceSheet,
    parkedSheetId: r.parkedSheetId,
  });

  return {
    list: async (options?: {
      favoritesOnly?: boolean;
    }): Promise<TalentWithSheets[]> => {
      const conditions = [scope];
      if (options?.favoritesOnly) {
        conditions.push(eq(talent.isFavorite, true));
      }
      const results = await withReferenceSheet(and(...conditions)).orderBy(
        desc(talent.isFavorite),
        asc(talent.name)
      );
      return results.map(toTalentWithSheets);
    },

    getByIds: async (ids: string[]): Promise<TalentWithSheets[]> => {
      if (ids.length === 0) return [];
      const results = await withReferenceSheet(
        and(scope, inArray(talent.id, ids))
      );
      return results.map(toTalentWithSheets);
    },

    getById: async (talentId: string): Promise<Talent | undefined> => {
      return db.query.talent.findFirst({
        where: { id: talentId, ...queryScope },
      });
    },

    /** The row with its whole sheet history (newest first) and media. */
    getWithRelations: async (talentId: string) => {
      return db.query.talent.findFirst({
        where: { id: talentId, ...queryScope },
        with: {
          sheets: {
            orderBy: { createdAt: 'desc' },
          },
          media: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });
    },

    sheets: {
      getById: async (sheetId: string): Promise<TalentSheet | undefined> => {
        return db.query.talentSheets.findFirst({
          where: { id: sheetId },
        });
      },
    },

    media: {
      getById: async (
        mediaId: string
      ): Promise<TalentMediaRecord | undefined> => {
        return db.query.talentMedia.findFirst({
          where: { id: mediaId },
        });
      },
    },
  };
}

function createTalentReadMethods(db: Database, teamId: string) {
  return createTalentReadMethodsScoped(db, teamId);
}

/**
 * Public (anonymous) talent reads — list and detail only, public-only scope.
 * The entire data boundary for the unauthenticated talent endpoints.
 */
export function createPublicTalentReadMethods(db: Database) {
  const { list, getWithRelations } = createTalentReadMethodsScoped(db, null);
  return { list, getWithRelations };
}

/** The fields a person may change on a talent, plus the headshot the sheet run writes. */
type TalentUpdate = Partial<
  Pick<Talent, 'name' | 'description' | 'isFavorite' | 'imageUrl' | 'imagePath'>
>;

export function createTalentMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const read = createTalentReadMethods(db, teamId);

  /** Every live cast link played by this talent (its sheet is their sheet input). */
  const revokeCastClaims = (talentId: string) =>
    demoteCharacterSheetClaims(db, castOfTalent(db, talentId));

  return {
    ...read,

    // Server-managed columns (isPublic, isTemplate, the pointers, …) are
    // excluded from the parameter type AND scrubbed at runtime: the type alone
    // doesn't stop a non-literal object from carrying extra keys, and drizzle
    // writes any key that matches a table column. Admin paths (the system
    // template seeder) insert via raw drizzle instead.
    create: async (
      data: Omit<NewTalent, ServerManagedTalentColumn>
    ): Promise<Talent> => {
      const [created] = await db
        .insert(talent)
        .values({
          ...stripServerManagedColumns(data, SERVER_MANAGED_TALENT_COLUMNS),
          teamId,
          createdBy: userId,
        })
        .returning();
      if (!created) throw new Error('Failed to create talent');
      return created;
    },

    update: async (
      talentId: string,
      data: TalentUpdate
    ): Promise<Talent | undefined> => {
      if (!(await getWritableTalent(db, talentId, teamId))) {
        return undefined;
      }

      // Claims (#1113): the description feeds this talent's own sheet run
      // and every character cast with it. (A rename is not a sheet input: the
      // sheet hash never covered the name.)
      const descriptionMoved = data.description !== undefined;
      const [[updated]] = await db.batch([
        db
          .update(talent)
          .set({
            ...data,
            ...(descriptionMoved ? { pendingPromoteSheetId: null } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)))
          .returning(),
        demoteCharacterSheetClaims(
          db,
          descriptionMoved ? castOfTalent(db, talentId) : sql`0`
        ),
      ]);
      return updated;
    },

    /**
     * Take the library sheet claim (#1113): point it at the `talent_sheets.id`
     * the run will write. Taken BEFORE the trigger (#1863), so no run is ever
     * live without one. With `onlyIfFree` it is taken only while no run holds
     * it: a deduplicated trigger may reuse an in-flight run, whose claim must
     * survive. Otherwise last kickoff wins.
     *
     * Taken only while the inputs the run was snapshotted from still hold:
     * the same description and every reference photo still present. An edit
     * that landed between the snapshot and this write found no claim to
     * revoke, so it fails the claim instead and the run parks. Returns
     * whether the claim was taken.
     */
    claimSheet: async (
      talentId: string,
      sheetId: string,
      inputs: { description: string | null; referenceImageUrls: string[] },
      options: { onlyIfFree: boolean }
    ): Promise<boolean> => {
      await requireWritableTalent(db, talentId, teamId);
      const urls = [...new Set(inputs.referenceImageUrls)];
      const photosStillThere =
        urls.length === 0
          ? undefined
          : sql`(${db
              .select({ n: sql`count(distinct ${talentMedia.url})` })
              .from(talentMedia)
              .where(
                and(
                  eq(talentMedia.talentId, talentId),
                  eq(talentMedia.type, 'image'),
                  inArray(talentMedia.url, urls)
                )
              )}) = ${urls.length}`;
      const result = await db
        .update(talent)
        .set({ pendingPromoteSheetId: sheetId, updatedAt: new Date() })
        .where(
          and(
            eq(talent.id, talentId),
            sql`${talent.description} IS ${inputs.description}`,
            photosStillThere,
            options.onlyIfFree
              ? isNull(talent.pendingPromoteSheetId)
              : undefined
          )
        );
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    /** A failed or handed-back run clears its claim — only while it still holds it. */
    clearSheetClaimIf: async (
      talentId: string,
      sheetId: string
    ): Promise<void> => {
      await db
        .update(talent)
        .set({ pendingPromoteSheetId: null, updatedAt: new Date() })
        .where(
          and(
            eq(talent.id, talentId),
            eq(talent.pendingPromoteSheetId, sheetId)
          )
        );
    },

    /**
     * Land a library sheet run's sheet (#1113, #2018). One batch: append the
     * row under the claimed id as parked, then — only while the claim still
     * names it — unpark it, make it the reference sheet, revoke the claims of
     * the characters cast with this talent (their sheets read its sheet), and
     * consume the claim. Returns the row and whether it landed; a parked row
     * is the caller's to report.
     *
     * Retry-safe: the insert is keyed on the claimed id, and the outcome is
     * read from the row.
     */
    landSheet: async (args: {
      sheetId: string;
      talentId: string;
      imageUrl: string;
      imagePath: string;
      metadata: NewTalentSheet['metadata'];
      source: NewTalentSheet['source'];
      inputHash: TalentSheetInputHash | null;
    }): Promise<{ sheet: TalentSheet; landed: boolean }> => {
      const { sheetId, talentId } = args;
      await requireWritableTalent(db, talentId, teamId);
      const holds = exists(
        db
          .select({ one: sql`1` })
          .from(talent)
          .where(
            and(
              eq(talent.id, talentId),
              eq(talent.pendingPromoteSheetId, sheetId)
            )
          )
      );
      const now = new Date();
      const [, , , , [sheet]] = await db.batch([
        db
          .insert(talentSheets)
          .values({
            id: sheetId,
            talentId,
            legacyName: LEGACY_SHEET_NAME,
            imageUrl: args.imageUrl,
            imagePath: args.imagePath,
            metadata: args.metadata,
            source: args.source,
            inputHash: args.inputHash,
            divergedAt: now,
          })
          .onConflictDoNothing(),
        db
          .update(talentSheets)
          .set({ divergedAt: null, updatedAt: now })
          .where(and(eq(talentSheets.id, sheetId), holds)),
        demoteCharacterSheetClaims(
          db,
          and(castOfTalent(db, talentId), holds) ?? sql`0`
        ),
        // The pointer moves and the claim is consumed in one guarded UPDATE.
        db
          .update(talent)
          .set({
            selectedSheetId: sheetId,
            pendingPromoteSheetId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(talent.id, talentId),
              eq(talent.pendingPromoteSheetId, sheetId)
            )
          ),
        db.select().from(talentSheets).where(eq(talentSheets.id, sheetId)),
      ]);
      if (!sheet) throw new Error(`TalentSheet ${sheetId} was not written`);
      return { sheet, landed: sheet.divergedAt === null };
    },

    /**
     * The user picks a sheet from the history as the reference sheet. The
     * pick wins over an in-flight run (its claim is revoked, so it parks) and
     * is a new face for every character cast with this talent. A discarded
     * row must be restored first.
     */
    selectSheet: async (
      talentId: string,
      sheetId: string
    ): Promise<TalentSheet> => {
      const { sheet } = await requireWritableSheet(db, sheetId, teamId);
      if (sheet.talentId !== talentId) {
        throw new ValidationError('That sheet belongs to another talent');
      }
      if (sheet.discardedAt) {
        throw new ValidationError('Restore the sheet before selecting it');
      }
      const now = new Date();
      const [, , , , [selected]] = await db.batch([
        db
          .update(talent)
          .set({ selectedSheetId: sheetId, updatedAt: now })
          .where(eq(talent.id, talentId)),
        db
          .update(talentSheets)
          .set({ divergedAt: null, updatedAt: now })
          .where(eq(talentSheets.id, sheetId)),
        demoteTalentSheetClaim(db, talentId),
        revokeCastClaims(talentId),
        db.select().from(talentSheets).where(eq(talentSheets.id, sheetId)),
      ]);
      if (!selected) throw new Error(`TalentSheet ${sheetId} vanished`);
      return selected;
    },

    /**
     * Refused while any character version names this talent as its cast
     * (#2018): the FK would blank that history. Recast or delete those
     * characters first.
     */
    delete: async (talentId: string): Promise<boolean> => {
      if (!(await getWritableTalent(db, talentId, teamId))) {
        return false;
      }
      const [named] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(characterBibleVersions)
        .where(eq(characterBibleVersions.talentId, talentId));
      if (named && named.n > 0) {
        throw new ValidationError(
          `${named.n} character version${named.n === 1 ? '' : 's'} cast this talent. Recast or delete those characters first.`
        );
      }

      const result = await db
        .delete(talent)
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    toggleFavorite: async (talentId: string): Promise<Talent | undefined> => {
      const existing = await getWritableTalent(db, talentId, teamId);
      if (!existing) return undefined;

      const [updated] = await db
        .update(talent)
        .set({ isFavorite: !existing.isFavorite, updatedAt: new Date() })
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)))
        .returning();
      return updated;
    },

    sheets: {
      ...read.sheets,

      /** Soft-delete a history row; the reference sheet cannot be discarded. */
      discard: async (sheetId: string): Promise<Date> => {
        const { sheet, talent: owner } = await requireWritableSheet(
          db,
          sheetId,
          teamId
        );
        if (owner.selectedSheetId === sheet.id) {
          throw new ValidationError(
            'This is the reference sheet. Select another sheet first.'
          );
        }
        const discardedAt = new Date();
        await db
          .update(talentSheets)
          .set({ discardedAt, updatedAt: discardedAt })
          .where(eq(talentSheets.id, sheetId));
        return discardedAt;
      },

      undiscard: async (sheetId: string): Promise<void> => {
        await requireWritableSheet(db, sheetId, teamId);
        await db
          .update(talentSheets)
          .set({ discardedAt: null, updatedAt: new Date() })
          .where(eq(talentSheets.id, sheetId));
      },
    },

    media: {
      ...read.media,

      create: async (data: NewTalentMedia): Promise<TalentMediaRecord> => {
        await requireWritableTalent(db, data.talentId, teamId);

        // A new reference photo is a sheet input the in-flight run did not
        // see (#1113): it parks.
        const [[media]] = await db.batch([
          db.insert(talentMedia).values(data).returning(),
          demoteTalentSheetClaim(db, data.talentId),
        ]);
        if (!media) throw new Error('Failed to create talent media');
        return media;
      },

      delete: async (mediaId: string): Promise<boolean> => {
        const media = await db.query.talentMedia.findFirst({
          where: { id: mediaId },
        });
        if (!media || !(await getWritableTalent(db, media.talentId, teamId))) {
          return false;
        }

        const [result] = await db.batch([
          db.delete(talentMedia).where(eq(talentMedia.id, mediaId)),
          // A reference photo the in-flight sheet run used is gone (#1113).
          demoteTalentSheetClaim(db, media.talentId),
        ]);
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        return (result.rowsAffected ?? 0) > 0;
      },
    },
  };
}
