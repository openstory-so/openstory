/**
 * Scoped Talent Sub-module
 * Team-scoped talent library CRUD with sheet counts and default sheets.
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
  characters,
  talent,
  talentMedia,
  talentSheets,
} from '@/platform/server/db/schema';
import type { TalentSheetInputHash } from '@/shots/input-hash';
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
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { stripServerManagedColumns } from '@/platform/server/db/scoped/server-managed';

const TALENT_WRITE_DENIED =
  'Talent not found or you do not have permission to modify it';

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

/** Resolve a sheet to its parent talent and enforce the write ACL. */
export async function assertTalentSheetWritableForTeam(
  db: Database,
  talentSheetId: string,
  teamId: string
): Promise<void> {
  const sheet = await db.query.talentSheets.findFirst({
    where: { id: talentSheetId },
  });
  if (!sheet) {
    throw new Error(`TalentSheet ${talentSheetId} not found`);
  }
  await requireWritableTalent(db, sheet.talentId, teamId);
}

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

  return {
    list: async (options?: {
      favoritesOnly?: boolean;
    }): Promise<TalentWithSheets[]> => {
      const conditions = [scope];
      if (options?.favoritesOnly) {
        conditions.push(eq(talent.isFavorite, true));
      }

      const results = await db
        .select({
          talent: talent,
          sheetCount: sql<number>`(
            SELECT COUNT(*) FROM talent_sheets
            WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
          )`
            .mapWith(Number)
            .as('sheet_count'),
        })
        .from(talent)
        .where(and(...conditions))
        .orderBy(desc(talent.isFavorite), asc(talent.name));

      const talentIds = results.map((r) => r.talent.id);
      if (talentIds.length === 0) return [];

      const defaultSheets = await db
        .select()
        .from(talentSheets)
        .where(
          and(
            sql`${talentSheets.talentId} IN (${sql.join(
              talentIds.map((id) => sql`${id}`),
              sql`, `
            )})`,
            eq(talentSheets.isDefault, true)
          )
        );

      const sheetMap = new Map<string, TalentSheet>(
        defaultSheets.map((s) => [s.talentId, s])
      );

      const talentWithoutDefault = talentIds.filter((id) => !sheetMap.has(id));
      if (talentWithoutDefault.length > 0) {
        // Exclude divergent sheets from the "any sheet" fallback so a
        // divergent first-time-generation row cannot leak into the
        // talent's displayed identity. Convergent rows are returned in
        // recency order; the most recent wins.
        const fallbackSheets = await db
          .select()
          .from(talentSheets)
          .where(
            and(
              sql`${talentSheets.talentId} IN (${sql.join(
                talentWithoutDefault.map((id) => sql`${id}`),
                sql`, `
              )})`,
              sql`${talentSheets.divergedAt} IS NULL`
            )
          )
          .orderBy(desc(talentSheets.createdAt));

        for (const sheet of fallbackSheets) {
          if (!sheetMap.has(sheet.talentId)) {
            sheetMap.set(sheet.talentId, sheet);
          }
        }
      }

      return results.map((r) => ({
        ...r.talent,
        sheetCount: r.sheetCount,
        sheets: [],
        defaultSheet: sheetMap.get(r.talent.id) ?? null,
      }));
    },

    getByIds: async (ids: string[]): Promise<TalentWithSheets[]> => {
      if (ids.length === 0) return [];

      const results = await db
        .select({
          talent: talent,
          sheetCount: sql<number>`(
            SELECT COUNT(*) FROM talent_sheets
            WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
          )`
            .mapWith(Number)
            .as('sheet_count'),
        })
        .from(talent)
        .where(
          and(
            scope,
            sql`${talent.id} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
        );

      if (results.length === 0) return [];

      const fetchedIds = results.map((r) => r.talent.id);
      const defaultSheets = await db
        .select()
        .from(talentSheets)
        .where(
          and(
            sql`${talentSheets.talentId} IN (${sql.join(
              fetchedIds.map((id) => sql`${id}`),
              sql`, `
            )})`,
            eq(talentSheets.isDefault, true)
          )
        );

      const sheetMap = new Map<string, TalentSheet>(
        defaultSheets.map((s) => [s.talentId, s])
      );

      const talentWithoutDefault = fetchedIds.filter((id) => !sheetMap.has(id));
      if (talentWithoutDefault.length > 0) {
        // Exclude divergent sheets from the "any sheet" fallback so a
        // divergent first-time-generation row cannot be cast as the talent's
        // identity by downstream consumers (e.g. talent-matching workflow,
        // which reads `defaultSheet?.imageUrl` for the LLM matching prompt).
        const fallbackSheets = await db
          .select()
          .from(talentSheets)
          .where(
            and(
              sql`${talentSheets.talentId} IN (${sql.join(
                talentWithoutDefault.map((id) => sql`${id}`),
                sql`, `
              )})`,
              sql`${talentSheets.divergedAt} IS NULL`
            )
          )
          .orderBy(desc(talentSheets.createdAt));

        for (const sheet of fallbackSheets) {
          if (!sheetMap.has(sheet.talentId)) {
            sheetMap.set(sheet.talentId, sheet);
          }
        }
      }

      return results.map((r) => ({
        ...r.talent,
        sheetCount: r.sheetCount,
        sheets: [],
        defaultSheet: sheetMap.get(r.talent.id) ?? null,
      }));
    },

    getById: async (talentId: string): Promise<Talent | undefined> => {
      return db.query.talent.findFirst({
        where: { id: talentId, ...queryScope },
      });
    },

    getWithRelations: async (talentId: string) => {
      return db.query.talent.findFirst({
        where: { id: talentId, ...queryScope },
        with: {
          sheets: {
            orderBy: { isDefault: 'desc', createdAt: 'desc' },
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

      isStale: async (
        sheetId: string,
        currentHash: string
      ): Promise<boolean> => {
        const result = await db
          .select({ hash: talentSheets.inputHash })
          .from(talentSheets)
          .where(eq(talentSheets.id, sheetId));
        const first = result[0];
        if (!first) {
          throw new Error(`TalentSheet ${sheetId} not found`);
        }
        const stored = first.hash;
        if (stored === null) return false;
        return currentHash !== stored;
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

export function createTalentMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const read = createTalentReadMethods(db, teamId);

  return {
    ...read,

    // Server-managed columns (isPublic, isTemplate, …) are excluded from the
    // parameter type AND scrubbed at runtime: the type alone doesn't stop a
    // non-literal object from carrying extra keys, and drizzle writes any key
    // that matches a table column. Admin paths (the system template seeder)
    // insert via raw drizzle instead.
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
      data: Partial<Omit<Talent, ServerManagedTalentColumn>>
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
            ...stripServerManagedColumns(data, SERVER_MANAGED_TALENT_COLUMNS),
            ...(descriptionMoved ? { pendingPromoteSheetId: null } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)))
          .returning(),
        demoteCharacterSheetClaims(
          db,
          descriptionMoved ? eq(characters.talentId, talentId) : sql`0`
        ),
      ]);
      return updated;
    },

    /**
     * Take the library sheet claim (#1113): point it at the `talent_sheets.id`
     * the run will write. Taken only once a trigger started a NEW run — a
     * deduplicated trigger that reused an in-flight run must leave that run's
     * claim alone. Last kickoff wins.
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
      inputs: { description: string | null; referenceImageUrls: string[] }
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
            photosStillThere
          )
        );
      return (result.rowsAffected ?? 0) > 0;
    },

    /** A failed run clears its claim — only while it still holds it. */
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
     * Land a library sheet run's sheet (#1113). One batch: insert the row
     * under the claimed id as parked (divergent, never default), then — only
     * while the claim still names it — unpark it, make a first upload the
     * default, revoke the claims of the characters cast with this talent
     * (their sheets read its sheets), and consume the claim. Returns the row
     * and whether it landed; a parked row is the caller's to report.
     *
     * Retry-safe: the insert is keyed on the claimed id, and the outcome is
     * read from the row.
     */
    landSheet: async (args: {
      sheetId: string;
      talentId: string;
      name: string;
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
      const [, , , , , [sheet]] = await db.batch([
        db
          .insert(talentSheets)
          .values({
            id: sheetId,
            talentId,
            name: args.name,
            imageUrl: args.imageUrl,
            imagePath: args.imagePath,
            metadata: args.metadata,
            isDefault: false,
            source: args.source,
            inputHash: args.inputHash,
            divergedAt: now,
          })
          .onConflictDoNothing(),
        db
          .update(talentSheets)
          .set({ divergedAt: null, updatedAt: now })
          .where(and(eq(talentSheets.id, sheetId), holds)),
        // Generated sheets never take the Default badge on their own; a
        // first uploaded sheet does (the same rule `sheets.create` applies).
        db
          .update(talentSheets)
          .set({ isDefault: true })
          .where(
            and(
              eq(talentSheets.id, sheetId),
              eq(talentSheets.source, 'manual_upload'),
              holds,
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(talentSheets)
                  .where(
                    and(
                      eq(talentSheets.talentId, talentId),
                      ne(talentSheets.id, sheetId)
                    )
                  )
              )
            )
          ),
        demoteCharacterSheetClaims(
          db,
          and(eq(characters.talentId, talentId), holds) ?? sql`0`
        ),
        db
          .update(talent)
          .set({ pendingPromoteSheetId: null, updatedAt: now })
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

    delete: async (talentId: string): Promise<boolean> => {
      if (!(await getWritableTalent(db, talentId, teamId))) {
        return false;
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

      create: async (data: NewTalentSheet): Promise<TalentSheet> => {
        await requireWritableTalent(db, data.talentId, teamId);

        const existingSheets = await db
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(talentSheets)
          .where(eq(talentSheets.talentId, data.talentId));

        const sheetCount = existingSheets[0]?.count ?? 0;
        // Honor an explicit `isDefault` (including `false`) so callers writing
        // a known non-default row — e.g. the divergence path in
        // `library-talent-sheet-workflow` — don't get auto-promoted to default
        // just because the talent has no sheets yet. Only fall back to the
        // first-sheet auto-promote when isDefault is undefined.
        const shouldBeDefault = data.isDefault ?? sheetCount === 0;

        if (shouldBeDefault && sheetCount > 0) {
          await db
            .update(talentSheets)
            .set({ isDefault: false })
            .where(eq(talentSheets.talentId, data.talentId));
        }

        // A new convergent sheet can become the cast identity: it revokes the
        // sheet claims of the characters cast with this talent (#1113).
        const [[sheet]] = await db.batch([
          db
            .insert(talentSheets)
            .values({ ...data, isDefault: shouldBeDefault })
            .returning(),
          demoteCharacterSheetClaims(
            db,
            data.divergedAt ? sql`0` : eq(characters.talentId, data.talentId)
          ),
        ]);
        if (!sheet) throw new Error('Failed to create talent sheet');
        return sheet;
      },

      update: async (
        sheetId: string,
        data: Partial<Omit<TalentSheet, 'id' | 'talentId' | 'createdAt'>>
      ): Promise<TalentSheet | undefined> => {
        const sheetForAcl = await db.query.talentSheets.findFirst({
          where: { id: sheetId },
        });
        if (
          !sheetForAcl ||
          !(await getWritableTalent(db, sheetForAcl.talentId, teamId))
        ) {
          return undefined;
        }

        if (data.isDefault) {
          await db
            .update(talentSheets)
            .set({ isDefault: false })
            .where(eq(talentSheets.talentId, sheetForAcl.talentId));
        }

        const [[updated]] = await db.batch([
          db
            .update(talentSheets)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(talentSheets.id, sheetId))
            .returning(),
          // The default and the image are cast inputs (#1113).
          demoteCharacterSheetClaims(
            db,
            eq(characters.talentId, sheetForAcl.talentId)
          ),
        ]);

        return updated;
      },

      delete: async (sheetId: string): Promise<boolean> => {
        const sheet = await db.query.talentSheets.findFirst({
          where: { id: sheetId },
        });
        if (!sheet || !(await getWritableTalent(db, sheet.talentId, teamId))) {
          return false;
        }

        const [result] = await db.batch([
          db.delete(talentSheets).where(eq(talentSheets.id, sheetId)),
          // Removing a sheet can move the cast identity (#1113).
          demoteCharacterSheetClaims(
            db,
            eq(characters.talentId, sheet.talentId)
          ),
        ]);

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        if ((result.rowsAffected ?? 0) === 0) return false;

        if (sheet.isDefault) {
          const remaining = await db
            .select()
            .from(talentSheets)
            .where(eq(talentSheets.talentId, sheet.talentId));

          const onlyRemaining = remaining[0];
          if (remaining.length === 1 && onlyRemaining) {
            await db
              .update(talentSheets)
              .set({ isDefault: true, updatedAt: new Date() })
              .where(eq(talentSheets.id, onlyRemaining.id));
          }
        }

        return true;
      },
    },

    media: {
      ...read.media,

      create: async (data: NewTalentMedia): Promise<TalentMediaRecord> => {
        await requireWritableTalent(db, data.talentId, teamId);

        const [media] = await db.insert(talentMedia).values(data).returning();
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
