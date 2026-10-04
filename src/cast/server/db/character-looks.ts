/**
 * Scoped Character Looks Sub-module (#2015)
 *
 * A look is an outfit on one character: an identity row, append-only
 * definition versions, and its own sheet with a claim. The look owns clothing;
 * "the character's sheet" is its default look's sheet.
 */

import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import { loadSceneContextBySequenceFromDb } from '@/shots/server/scene-script';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import type {
  CharacterLook,
  CharacterLookVersion,
  LookDefinition,
  LookVersionSource,
} from '@/platform/server/db/schema';
import {
  DEFAULT_LOOK_NAME,
  LOOK_FIELDS,
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  characterSheetVariants,
  characters,
} from '@/platform/server/db/schema';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';
import { characterBibleColumns, mergeDefined } from './bible-versions';

/**
 * A look's live sheet version: the explicit selection, else — for a default
 * look only — the row the #1419 backfill keyed to the character's own id.
 * That pointer stays NULL on purpose (it feeds the shot hash as
 * `selectedSheetVersionId ?? sheetInputHash`), and the #2015 backfill copied
 * the NULL across with it.
 */
export const liveLookSheetVersionId = sql`COALESCE(${characterLooks.selectedSheetVersionId}, CASE WHEN ${characterLooks.isDefault} THEN ${characterLooks.characterId} END)`;

const { selectedLookVersionId: _pointer, ...lookRowColumns } =
  getTableColumns(characterLooks);

const lookColumns = {
  ...lookRowColumns,
  lookVersionId: characterLookVersions.id,
  name: characterLookVersions.name,
  clothing: characterLookVersions.clothing,
  styling: characterLookVersions.styling,
  sheetImageUrl: characterSheetVariants.url,
  sheetImagePath: characterSheetVariants.storagePath,
  sheetGeneratedAt: characterSheetVariants.generatedAt,
  sheetInputHash: characterSheetVariants.inputHash,
};

/** The sheet inputs of a look: an edit to one revokes its sheet claim. */
const LOOK_SHEET_FIELDS = ['clothing', 'styling'] as const;

const lookChanged = (before: LookDefinition, after: LookDefinition) =>
  LOOK_FIELDS.filter((key) => (before[key] ?? null) !== (after[key] ?? null));

/** What a sheet run was snapshotted from: the claim is taken only while it holds. */
export type LookSheetSnapshot = {
  lookVersionId: string;
  bibleVersionId: string | null;
  talentId: string | null;
};

const selectLooks = (db: Database) =>
  db
    .select(lookColumns)
    .from(characterLooks)
    .innerJoin(
      characterLookVersions,
      eq(characterLookVersions.id, characterLooks.selectedLookVersionId)
    )
    .leftJoin(
      characterSheetVariants,
      eq(characterSheetVariants.id, liveLookSheetVersionId)
    );

/** Default first, then the order they were added. */
const lookOrder = [
  desc(characterLooks.isDefault),
  asc(characterLooks.sortOrder),
  asc(characterLooks.id),
];

/**
 * Give a character an older worker wrote during the #2015 deploy its default
 * look, from the legacy columns the backfill read. The ids are the
 * character's own, as the backfill's are, so a race inserts nothing twice.
 */
const backfillDefaultLook = async (
  db: Database,
  characterId: string
): Promise<void> => {
  const [legacy] = await db
    .select({
      id: characters.id,
      clothing: sql<
        string | null
      >`CASE WHEN ${characterBibleVersions.id} IS NULL THEN ${characters.legacyStandardClothing} ELSE ${characterBibleVersions.legacyStandardClothing} END`,
      sheetStatus: characters.legacySheetStatus,
      sheetError: characters.legacySheetError,
      selectedSheetVersionId: characters.legacySelectedSheetVersionId,
      pendingPromoteSheetVersionId:
        characters.legacyPendingPromoteSheetVersionId,
    })
    .from(characters)
    .leftJoin(
      characterBibleVersions,
      eq(characterBibleVersions.id, characters.selectedBibleVersionId)
    )
    .where(eq(characters.id, characterId));
  if (!legacy) return;
  await db.batch([
    db
      .insert(characterLooks)
      .values({
        id: legacy.id,
        characterId: legacy.id,
        isDefault: true,
        sortOrder: 0,
        selectedLookVersionId: legacy.id,
        selectedSheetVersionId: legacy.selectedSheetVersionId,
        pendingPromoteSheetVersionId: legacy.pendingPromoteSheetVersionId,
        sheetStatus: legacy.sheetStatus,
        sheetError: legacy.sheetError,
      })
      .onConflictDoNothing(),
    db
      .insert(characterLookVersions)
      .values({
        id: legacy.id,
        lookId: legacy.id,
        name: DEFAULT_LOOK_NAME,
        clothing: legacy.clothing,
        styling: null,
        source: 'backfill',
        createdBy: null,
      })
      .onConflictDoNothing(),
  ]);
};

const getLook = async (
  db: Database,
  id: string
): Promise<CharacterLook | null> => {
  const [look] = await selectLooks(db).where(eq(characterLooks.id, id));
  return look ?? null;
};

/**
 * The look a write is about to touch. A character with no look yet answers
 * to its own id (the id its default look takes), so that case is filled in
 * here rather than at every writer.
 */
export const requireLook = async (
  db: Database,
  id: string
): Promise<CharacterLook> => {
  const found = await getLook(db, id);
  if (found) return found;
  await backfillDefaultLook(db, id);
  const look = await getLook(db, id);
  if (!look) throw new NotFoundError(`Look ${id} not found`);
  return look;
};

/** The sequence and name of a look's character, for its events. */
const ownerOf = async (db: Database, characterId: string) => {
  const [owner] = await db
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
  if (!owner) throw new NotFoundError(`Character ${characterId} not found`);
  return owner;
};

/**
 * The one writer of a look's definition: the statements that append a
 * version and point the look at it, for the caller's own `db.batch`. A
 * change to clothing or styling revokes the look's in-flight sheet claim
 * (#1113) in the same batch; a rename does not. Empty when nothing moved.
 */
export const lookDefinitionWrite = (
  db: Database,
  look: CharacterLook,
  patch: Partial<LookDefinition>,
  opts: { source: LookVersionSource; createdBy: string | null }
) => {
  const before: LookDefinition = {
    name: look.name,
    clothing: look.clothing,
    styling: look.styling,
  };
  const after = mergeDefined(before, patch, LOOK_FIELDS);
  const moved = lookChanged(before, after);
  if (moved.length === 0) return { moved, after, statements: [] };
  const versionId = generateId();
  const touchesSheet = moved.some((key) =>
    (LOOK_SHEET_FIELDS as readonly string[]).includes(key)
  );
  return {
    moved,
    after,
    statements: [
      db.insert(characterLookVersions).values({
        id: versionId,
        lookId: look.id,
        ...after,
        source: opts.source,
        createdBy: opts.createdBy,
      }),
      db
        .update(characterLooks)
        .set({
          selectedLookVersionId: versionId,
          ...(touchesSheet ? { pendingPromoteSheetVersionId: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(characterLooks.id, look.id)),
    ],
  };
};

/**
 * Two live looks of one character never share a name: the name is what a
 * person picks by, and what a re-analysis matches on.
 */
const requireFreeName = async (
  db: Database,
  characterId: string,
  name: string,
  exceptLookId: string | null
): Promise<void> => {
  const taken = await selectLooks(db).where(
    and(
      eq(characterLooks.characterId, characterId),
      sql`${characterLooks.deletedAt} IS NULL`
    )
  );
  const wanted = name.trim().toLowerCase();
  if (
    taken.some(
      (row) =>
        row.id !== exceptLookId && row.name.trim().toLowerCase() === wanted
    )
  ) {
    throw new ConflictError(`This character already has a look named ${name}.`);
  }
};

/**
 * Delete every look of the characters `where` matches. Looks RESTRICT their
 * character's delete (the #612 rebuild trap), so these two statements go
 * before it, in the same batch.
 */
export const deleteLooksOfCharacters = (
  db: Database,
  where: SQL | undefined
) => {
  const theirs = db.select({ id: characters.id }).from(characters).where(where);
  return [
    db
      .delete(characterLookVersions)
      .where(
        inArray(
          characterLookVersions.lookId,
          db
            .select({ id: characterLooks.id })
            .from(characterLooks)
            .where(inArray(characterLooks.characterId, theirs))
        )
      ),
    db
      .delete(characterLooks)
      .where(inArray(characterLooks.characterId, theirs)),
  ] as const;
};

export function createCharacterLooksMethods(db: Database) {
  return {
    getById: (id: string) => getLook(db, id),

    /**
     * A character's default look, created from its legacy columns when an
     * older worker wrote the character without one.
     */
    ensureDefault: (characterId: string) => requireLook(db, characterId),

    /** A character's looks, default first. Removed ones only on request. */
    listByCharacter: async (
      characterId: string,
      options?: { includeRemoved?: boolean }
    ): Promise<CharacterLook[]> =>
      await selectLooks(db)
        .where(
          and(
            eq(characterLooks.characterId, characterId),
            options?.includeRemoved
              ? undefined
              : sql`${characterLooks.deletedAt} IS NULL`
          )
        )
        .orderBy(...lookOrder),

    /**
     * Every look of these characters, removed ones included: a scene that
     * still picks a removed look keeps wearing it. Chunked below D1's
     * 100-bound-parameter cap.
     */
    listByCharacters: async (
      characterIds: readonly string[]
    ): Promise<CharacterLook[]> => {
      const rows: CharacterLook[] = [];
      for (let i = 0; i < characterIds.length; i += 80)
        rows.push(
          ...(await selectLooks(db)
            .where(
              inArray(characterLooks.characterId, characterIds.slice(i, i + 80))
            )
            .orderBy(...lookOrder))
        );
      return rows;
    },

    /** Definition history of one look, newest first. */
    listVersions: async (lookId: string): Promise<CharacterLookVersion[]> =>
      await db
        .select()
        .from(characterLookVersions)
        .where(eq(characterLookVersions.lookId, lookId))
        .orderBy(
          desc(characterLookVersions.createdAt),
          desc(characterLookVersions.id)
        ),

    /**
     * Every look version of the sequence's characters, oldest first.
     * Staleness causes diff the version a sheet was drawn from against the
     * live one.
     */
    listVersionsBySequence: async (
      sequenceId: string
    ): Promise<CharacterLookVersion[]> =>
      await db
        .select(getTableColumns(characterLookVersions))
        .from(characterLookVersions)
        .innerJoin(
          characterLooks,
          eq(characterLooks.id, characterLookVersions.lookId)
        )
        .innerJoin(characters, eq(characters.id, characterLooks.characterId))
        .where(eq(characters.sequenceId, sequenceId))
        .orderBy(
          asc(characterLookVersions.createdAt),
          asc(characterLookVersions.id)
        ),

    /**
     * Write a character's analysed looks (#2015), the default first, and say
     * which look each analysis id landed on.
     *
     * A look is matched by NAME (case-blind) to a look of the character, so
     * a re-analysis keeps its id, its sheet and its history; a removed look
     * the script names again comes back. Each row is matched at most once,
     * and a new one is added for a name the character does not have. The
     * default look takes the first entry's name and styling (its clothing
     * came in with the character's upsert); a look that already had that
     * name is the same outfit, so it is retired below rather than left as a
     * twin.
     *
     * A look this analysis no longer names is soft-removed only when nothing
     * is lost: every version of it came from analysis, it has no sheet, and
     * no scene wears it. A look a person made or edited, one with a sheet,
     * and one a scene wears are never touched.
     */
    syncFromAnalysis: async (
      characterId: string,
      analysed: readonly {
        lookId: string;
        name: string;
        clothing: string;
        styling: string;
      }[]
    ): Promise<Record<string, string>> => {
      const opts = { source: 'analysis' as const, createdBy: null };
      const defaultLook = await requireLook(db, characterId);
      const others = (
        await selectLooks(db).where(eq(characterLooks.characterId, characterId))
      ).filter((row) => !row.isDefault);
      const write = async (
        look: CharacterLook,
        patch: Partial<LookDefinition>
      ) => {
        const { statements } = lookDefinitionWrite(db, look, patch, opts);
        const [first, ...rest] = statements;
        if (first) await db.batch([first, ...rest]);
      };
      const key = (name: string) => name.trim().toLowerCase();
      const matched = new Set<string>();
      const ids: Record<string, string> = {};
      for (const [index, look] of analysed.entries()) {
        const definition = {
          name: look.name.trim() || DEFAULT_LOOK_NAME,
          clothing: look.clothing.trim() || null,
          styling: look.styling.trim() || null,
        };
        if (index === 0) {
          // Clothing is the character upsert's: a talent match may have
          // kept the role's wardrobe, and that write already landed.
          await write(defaultLook, {
            name: definition.name,
            styling: definition.styling,
          });
          ids[look.lookId] = defaultLook.id;
          continue;
        }
        const existing = others.find(
          (row) =>
            !matched.has(row.id) && key(row.name) === key(definition.name)
        );
        if (existing) {
          matched.add(existing.id);
          await write(existing, definition);
          if (existing.deletedAt) {
            await db
              .update(characterLooks)
              .set({ deletedAt: null, updatedAt: new Date() })
              .where(eq(characterLooks.id, existing.id));
          }
          ids[look.lookId] = existing.id;
          continue;
        }
        const id = generateId();
        const versionId = generateId();
        await db.batch([
          db.insert(characterLooks).values({
            id,
            characterId,
            isDefault: false,
            sortOrder: others.length + index,
            selectedLookVersionId: versionId,
            sheetStatus: 'pending',
          }),
          db.insert(characterLookVersions).values({
            id: versionId,
            lookId: id,
            ...definition,
            ...opts,
          }),
        ]);
        matched.add(id);
        ids[look.lookId] = id;
      }

      // Retire what this analysis left behind, where nothing is lost.
      const stale = others.filter(
        (row) =>
          !matched.has(row.id) &&
          !row.deletedAt &&
          !row.selectedSheetVersionId &&
          !row.sheetImageUrl &&
          row.sheetStatus !== 'generating' &&
          !row.pendingPromoteSheetVersionId
      );
      if (stale.length > 0) {
        const owner = await ownerOf(db, characterId);
        const worn = new Set(
          [
            ...(
              await loadSceneContextBySequenceFromDb(db, owner.sequenceId)
            ).values(),
          ].flatMap(({ scene }) =>
            Object.values(scene.continuity?.characterLooks ?? {})
          )
        );
        for (const row of stale) {
          if (worn.has(row.id)) continue;
          const authored = await db
            .select({ source: characterLookVersions.source })
            .from(characterLookVersions)
            .where(eq(characterLookVersions.lookId, row.id));
          if (authored.some((version) => version.source !== 'analysis')) {
            continue;
          }
          const deletedAt = new Date();
          await db.batch([
            db
              .update(characterLooks)
              .set({ deletedAt, updatedAt: deletedAt })
              .where(eq(characterLooks.id, row.id)),
            buildEventInsert(db, {
              sequenceId: owner.sequenceId,
              actorId: null,
              kind: 'look.removed',
              targetType: 'character',
              targetId: characterId,
              summary: `Removed look ${row.name} of ${owner.name}: the script no longer has it`,
              data: { lookId: row.id, name: row.name, by: 'analysis' },
            }),
          ]);
        }
      }
      return ids;
    },

    /** Add a look to a character. It has no sheet until someone asks for one. */
    create: async (
      characterId: string,
      definition: LookDefinition,
      opts: { source: LookVersionSource; actorId: string | null }
    ): Promise<CharacterLook> => {
      const owner = await ownerOf(db, characterId);
      // A character with no look yet gets its default first, so the new one
      // is never the only look and never mistaken for the default.
      await backfillDefaultLook(db, characterId);
      await requireFreeName(db, characterId, definition.name, null);
      const [last] = await db
        .select({ sortOrder: characterLooks.sortOrder })
        .from(characterLooks)
        .where(eq(characterLooks.characterId, characterId))
        .orderBy(desc(characterLooks.sortOrder))
        .limit(1);
      const id = generateId();
      const versionId = generateId();
      await db.batch([
        db.insert(characterLooks).values({
          id,
          characterId,
          isDefault: false,
          sortOrder: (last?.sortOrder ?? 0) + 1,
          selectedLookVersionId: versionId,
          sheetStatus: 'pending',
        }),
        db.insert(characterLookVersions).values({
          id: versionId,
          lookId: id,
          ...definition,
          source: opts.source,
          createdBy: opts.actorId,
        }),
        buildEventInsert(db, {
          sequenceId: owner.sequenceId,
          actorId: opts.actorId,
          kind: 'look.created',
          targetType: 'character',
          targetId: characterId,
          summary: `Added look ${definition.name} to ${owner.name}`,
          data: { lookId: id, name: definition.name },
        }),
      ]);
      return await requireLook(db, id);
    },

    /**
     * Edit a look: appends a version and moves the pointer, with a
     * `look.updated` event carrying the previous values. A change to
     * clothing or styling revokes the look's sheet claim (#1113); its sheet
     * and the shots of the scenes that pick it read stale by derivation.
     */
    update: async (
      lookId: string,
      patch: Partial<LookDefinition>,
      opts: { source: LookVersionSource; actorId: string | null }
    ): Promise<CharacterLook> => {
      const look = await requireLook(db, lookId);
      if (patch.name !== undefined) {
        await requireFreeName(db, look.characterId, patch.name, look.id);
      }
      const { moved, statements } = lookDefinitionWrite(db, look, patch, {
        source: opts.source,
        createdBy: opts.actorId,
      });
      const [first, ...rest] = statements;
      if (!first) return look;
      const owner = await ownerOf(db, look.characterId);
      await db.batch([
        first,
        ...rest,
        buildEventInsert(db, {
          sequenceId: owner.sequenceId,
          actorId: opts.actorId,
          kind: 'look.updated',
          targetType: 'character',
          targetId: look.characterId,
          summary: `Edited look ${patch.name ?? look.name} of ${owner.name}`,
          data: {
            lookId,
            prevState: Object.fromEntries(moved.map((key) => [key, look[key]])),
            prevLookVersionId: look.lookVersionId,
          },
        }),
      ]);
      return await requireLook(db, lookId);
    },

    /**
     * Re-point a look at one of its own earlier versions. Clothing or
     * styling moving with it revokes the sheet claim, like an edit.
     */
    selectVersion: async (
      lookId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<CharacterLook> => {
      const look = await requireLook(db, lookId);
      const [version] = await db
        .select()
        .from(characterLookVersions)
        .where(
          and(
            eq(characterLookVersions.id, versionId),
            eq(characterLookVersions.lookId, lookId)
          )
        );
      if (!version) {
        throw new NotFoundError(
          `Look version ${versionId} not found for look ${lookId}`
        );
      }
      if (version.id === look.lookVersionId) return look;
      const owner = await ownerOf(db, look.characterId);
      const sheetMoved = LOOK_SHEET_FIELDS.some(
        (key) => (version[key] ?? null) !== (look[key] ?? null)
      );
      await db.batch([
        db
          .update(characterLooks)
          .set({
            selectedLookVersionId: version.id,
            ...(sheetMoved ? { pendingPromoteSheetVersionId: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(characterLooks.id, lookId)),
        buildEventInsert(db, {
          sequenceId: owner.sequenceId,
          actorId: opts.actorId,
          kind: 'look.version-selected',
          targetType: 'character',
          targetId: look.characterId,
          summary: `Selected a version of look ${version.name} of ${owner.name}`,
          data: {
            lookId,
            versionId,
            prevLookVersionId: look.lookVersionId,
          },
        }),
      ]);
      return await requireLook(db, lookId);
    },

    /**
     * Soft-remove a look (undoable). The default look is refused: every
     * character wears something. So is a look a scene still picks: the
     * error names the scenes, and nothing is quietly re-dressed. Returns the
     * timestamp for the toast Undo.
     */
    remove: async (
      lookId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const look = await requireLook(db, lookId);
      if (look.isDefault) {
        throw new ValidationError('The default look cannot be removed.');
      }
      if (look.deletedAt) return look.deletedAt;
      const owner = await ownerOf(db, look.characterId);
      const wornIn = [
        ...(
          await loadSceneContextBySequenceFromDb(db, owner.sequenceId)
        ).values(),
      ]
        .filter(({ scene }) =>
          Object.values(scene.continuity?.characterLooks ?? {}).includes(lookId)
        )
        .sort((a, b) => a.scene.orderIndex - b.scene.orderIndex)
        .map(({ scene }) => `scene ${scene.orderIndex + 1}`);
      if (wornIn.length > 0) {
        throw new ConflictError(
          `${look.name} is worn in ${wornIn.join(', ')}. Pick another look there first.`
        );
      }
      const deletedAt = new Date();
      await db.batch([
        db
          .update(characterLooks)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(eq(characterLooks.id, lookId)),
        buildEventInsert(db, {
          sequenceId: owner.sequenceId,
          actorId: opts.actorId,
          kind: 'look.removed',
          targetType: 'character',
          targetId: look.characterId,
          summary: `Removed look ${look.name} of ${owner.name}`,
          data: { lookId, name: look.name },
        }),
      ]);
      return deletedAt;
    },

    /** Undo a remove. */
    restore: async (
      lookId: string,
      opts: { actorId: string | null }
    ): Promise<CharacterLook> => {
      const look = await requireLook(db, lookId);
      if (!look.deletedAt) return look;
      await requireFreeName(db, look.characterId, look.name, look.id);
      const owner = await ownerOf(db, look.characterId);
      await db.batch([
        db
          .update(characterLooks)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(characterLooks.id, lookId)),
        buildEventInsert(db, {
          sequenceId: owner.sequenceId,
          actorId: opts.actorId,
          kind: 'look.restored',
          targetType: 'character',
          targetId: look.characterId,
          summary: `Restored look ${look.name} of ${owner.name}`,
          data: { lookId, name: look.name },
        }),
      ]);
      return await requireLook(db, lookId);
    },

    /**
     * Take a look's sheet claim (#1113): mint the id the run's version row
     * will carry and point the claim at it. Last kickoff wins.
     *
     * Taken only while the inputs the run was snapshotted from still hold —
     * the same look version, bible version and cast talent (#1863). An edit
     * that landed between the snapshot and this write found no claim to
     * revoke, so the claim is not taken and the run parks its sheet as
     * divergent. The id is returned either way: the run still needs one.
     *
     * `markGenerating: false` leaves the status alone, for a caller whose own
     * write already set it.
     */
    claimSheet: async (
      lookId: string,
      snapshot: LookSheetSnapshot,
      opts: { markGenerating: boolean }
    ): Promise<{ versionId: string; held: boolean }> => {
      const look = await requireLook(db, lookId);
      const versionId = generateId();
      const result = await db
        .update(characterLooks)
        .set({
          pendingPromoteSheetVersionId: versionId,
          ...(opts.markGenerating
            ? { sheetStatus: 'generating' as const, sheetError: null }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(characterLooks.id, lookId),
            eq(characterLooks.selectedLookVersionId, snapshot.lookVersionId),
            sql`EXISTS ${db
              .select({ one: sql`1` })
              .from(characters)
              .where(
                and(
                  eq(characters.id, look.characterId),
                  // A payload an older worker froze does not say what it
                  // read: one from before #1600 names no bible version, one
                  // from before #2015 no cast talent. Absent is "unknown",
                  // not "none", so that part of the guard is skipped —
                  // reading it as null would refuse every cast character.
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a payload frozen before #1600
                  snapshot.bibleVersionId === undefined
                    ? undefined
                    : sql`${characters.selectedBibleVersionId} IS ${snapshot.bibleVersionId}`,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a payload frozen before #2015
                  snapshot.talentId === undefined
                    ? undefined
                    : sql`${characters.talentId} IS ${snapshot.talentId}`
                )
              )}`
          )
        );
      return { versionId, held: (result.rowsAffected ?? 0) > 0 };
    },

    /**
     * A sheet run failed (#1113): clear its claim and mark the sheet failed —
     * only while it still holds the claim, or nobody does. A newer run's claim
     * and its `generating` status are left alone. `versionId` is null for a
     * run queued before #1113, which holds no claim.
     */
    failSheetClaim: async (
      lookId: string,
      versionId: string | null,
      error: string
    ): Promise<void> => {
      await requireLook(db, lookId);
      await db
        .update(characterLooks)
        .set({
          pendingPromoteSheetVersionId: null,
          sheetStatus: 'failed',
          sheetError: error,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(characterLooks.id, lookId),
            versionId === null
              ? sql`${characterLooks.pendingPromoteSheetVersionId} IS NULL`
              : sql`(${characterLooks.pendingPromoteSheetVersionId} = ${versionId} OR ${characterLooks.pendingPromoteSheetVersionId} IS NULL)`
          )
        );
    },
  };
}
