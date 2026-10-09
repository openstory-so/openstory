/**
 * Scoped Character Looks Sub-module (#2015)
 *
 * A look is an outfit on one character: an identity row, append-only
 * definition versions, and its own sheet with a claim. The look owns clothing;
 * "the character's sheet" is its default look's sheet. A look belongs to the
 * character, so every sequence that casts the character reads the same
 * definition and the same sheet (#2017).
 */

import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
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
  sequenceCast,
  sequences,
} from '@/platform/server/db/schema';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';
import { effectiveStyling } from '@/cast/character-looks';
import {
  characterBibleColumns,
  legacyBibleFeatures,
  mergeDefined,
} from './bible-versions';
import { analysisMayNotRewrite } from './sequence-cast';
import { demoteCharacterSheetClaims } from './sheet-claims';

/**
 * A look's live sheet version: its explicit selection, else — for a default
 * look only — the row the #1419 backfill keyed to the character's own id.
 * That pointer stays NULL on purpose (it feeds the shot hash as
 * `selectedSheetVersionId ?? sheetInputHash`), and the #2015 backfill copied
 * the NULL across with it.
 */
export const liveLookSheetVersionId = sql`COALESCE(${characterLooks.selectedSheetVersionId}, CASE WHEN ${characterLooks.isDefault} THEN ${characterLooks.characterId} END)`;

// The look's own columns; the version pointer is read as `lookVersionId`.
const { selectedLookVersionId: _pointer, ...lookRowColumns } =
  getTableColumns(characterLooks);

const lookColumns = {
  ...lookRowColumns,
  lookVersionId: characterLookVersions.id,
  name: characterLookVersions.name,
  clothing: characterLookVersions.clothing,
  styling: characterLookVersions.styling,
  // The current bible version's legacy features (#2065); see resolveStyling.
  legacyFeatures: legacyBibleFeatures,
  sheetImageUrl: characterSheetVariants.url,
  sheetImagePath: characterSheetVariants.storagePath,
  sheetGeneratedAt: characterSheetVariants.generatedAt,
  sheetInputHash: characterSheetVariants.inputHash,
};

/**
 * A look row as every read returns it (#2065): `styling` resolved through
 * `effectiveStyling` — on the default look, its own joined with the legacy
 * features text of the character's current bible version — and the
 * version's own column kept as `storedStyling`.
 */
const resolveStyling = <
  T extends {
    isDefault: boolean;
    styling: string | null;
    legacyFeatures: string | null;
  },
>({
  legacyFeatures,
  ...row
}: T) => ({
  ...row,
  storedStyling: row.styling,
  styling: row.isDefault
    ? effectiveStyling(row.styling, legacyFeatures)
    : row.styling,
});

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

/**
 * The looks of the team's characters, each at its current version with its
 * sheet.
 */
const selectLooks = async (
  db: Database,
  teamId: string,
  where: SQL | undefined,
  order: readonly SQL[] = []
): Promise<CharacterLook[]> =>
  (
    await db
      .select(lookColumns)
      .from(characterLooks)
      .innerJoin(characters, eq(characters.id, characterLooks.characterId))
      .innerJoin(
        characterLookVersions,
        eq(characterLookVersions.id, characterLooks.selectedLookVersionId)
      )
      .leftJoin(
        characterBibleVersions,
        eq(characterBibleVersions.id, characters.selectedBibleVersionId)
      )
      .leftJoin(
        characterSheetVariants,
        eq(characterSheetVariants.id, liveLookSheetVersionId)
      )
      .where(and(eq(characters.teamId, teamId), where))
      .orderBy(...order)
  ).map(resolveStyling);

/** A look as the team has it: the same read as everywhere else. */
export type TeamLook = CharacterLook;

/** Default first, then the order they were added. */
const lookOrder = [
  desc(characterLooks.isDefault),
  asc(characterLooks.sortOrder),
  asc(characterLooks.id),
];

/**
 * Give a character an older worker wrote during the #2015 deploy its default
 * look, from the legacy columns that backfill read. The ids are the
 * character's own, as the backfill's are, so a race inserts nothing twice.
 * Nothing is written for a character that already has a default look.
 */
const backfillDefaultLook = async (
  db: Database,
  teamId: string,
  characterId: string
): Promise<void> => {
  const rows = await db
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
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.teamId, teamId),
        sql`NOT EXISTS (SELECT 1 FROM ${characterLooks} WHERE ${characterLooks.id} = ${characters.id})`
      )
    );
  const [legacy] = rows;
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
  teamId: string,
  id: string
): Promise<CharacterLook | null> =>
  (await selectLooks(db, teamId, eq(characterLooks.id, id)))[0] ?? null;

/**
 * The look a write is about to touch. A character with no look yet answers
 * to its own id (the id its default look takes), so that case is filled in
 * here rather than at every writer.
 */
export const requireLook = async (
  db: Database,
  teamId: string,
  id: string
): Promise<CharacterLook> => {
  const found = await getLook(db, teamId, id);
  if (found) return found;
  await backfillDefaultLook(db, teamId, id);
  const look = await getLook(db, teamId, id);
  if (!look) throw new NotFoundError(`Look ${id} not found`);
  return look;
};

/**
 * A character's looks, default first, removed ones included (`deletedAt`),
 * as a cast read's `looks` are.
 */
export const currentLooksOf = async (
  db: Database,
  teamId: string,
  characterId: string
): Promise<CharacterLook[]> =>
  await selectLooks(
    db,
    teamId,
    eq(characterLooks.characterId, characterId),
    lookOrder
  );

/**
 * A character's cast link in one sequence (#2017): the name its events carry
 * and the link a re-analysis revives.
 */
const ownerOf = async (
  db: Database,
  teamId: string,
  sequenceId: string,
  characterId: string
) => {
  const owners = await db
    .select({
      castId: sequenceCast.id,
      sequenceId: sequenceCast.sequenceId,
      name: characterBibleColumns.name,
    })
    .from(sequenceCast)
    .innerJoin(characters, eq(characters.id, sequenceCast.characterId))
    .leftJoin(
      characterBibleVersions,
      eq(characterBibleVersions.id, characters.selectedBibleVersionId)
    )
    .where(
      and(
        eq(sequenceCast.characterId, characterId),
        eq(sequenceCast.sequenceId, sequenceId),
        eq(characters.teamId, teamId)
      )
    );
  const [owner] = owners;
  if (!owner) throw new NotFoundError(`Character ${characterId} not found`);
  return owner;
};

/**
 * The character's name for an event written from a sequence, or no event
 * from no sequence (#2065, the Characters page) — where a deleted character
 * is not written until it is restored.
 */
const eventOwner = async (
  db: Database,
  teamId: string,
  sequenceId: string | null,
  characterId: string
) => {
  if (sequenceId !== null) {
    return await ownerOf(db, teamId, sequenceId, characterId);
  }
  const [live] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.teamId, teamId),
        isNull(characters.deletedAt)
      )
    );
  if (!live) throw new NotFoundError(`Character ${characterId} not found`);
  return null;
};

/**
 * A new look's own row, for the caller's own `db.batch`. It has no sheet
 * until someone asks for one.
 */
const newLookRow = (
  db: Database,
  look: {
    id: string;
    versionId: string;
    characterId: string;
    sortOrder: number;
  }
) =>
  db.insert(characterLooks).values({
    id: look.id,
    characterId: look.characterId,
    isDefault: false,
    sortOrder: look.sortOrder,
    selectedLookVersionId: look.versionId,
    sheetStatus: 'pending',
  });

/**
 * The one writer of a look's definition: the statements that append a
 * version and make it the look's current one, for the caller's own
 * `db.batch`. A change to clothing or styling revokes the in-flight sheet
 * claim (#1113) in the same batch; a rename does not. Empty when nothing
 * moved. `sequenceId` is the sequence the write was made from, for the
 * event the features move writes; null from the Characters page (#2065).
 *
 * `look.styling` is the effective styling (#2065), so a save that submits
 * what the field showed moves nothing. The version row holds the look's OWN
 * styling: the stored column while the styling is not edited (a rename or a
 * clothing edit moves no legacy text, so no digest stamped before #2065
 * moves with it), the submitted text once it is. That first styling edit of
 * a default look is the move: {@link legacyFeaturesMove} nulls the bible's
 * legacy features in the same batch.
 */
export const lookDefinitionWrite = async (
  db: Database,
  look: LookDefinition & {
    id: string;
    isDefault: boolean;
    storedStyling: string | null;
  },
  patch: Partial<LookDefinition>,
  opts: {
    source: LookVersionSource;
    createdBy: string | null;
    sequenceId: string | null;
  }
) => {
  const before: LookDefinition = {
    name: look.name,
    clothing: look.clothing,
    styling: look.styling,
  };
  const after = mergeDefined(before, patch, LOOK_FIELDS);
  const moved = lookChanged(before, after);
  if (moved.length === 0) {
    return { moved, after, versionId: null, statements: [] };
  }
  const versionId = generateId();
  const touchesSheet = moved.some((key) =>
    (LOOK_SHEET_FIELDS as readonly string[]).includes(key)
  );
  const stylingMoved = moved.includes('styling');
  const legacyMove =
    stylingMoved && look.isDefault
      ? await legacyFeaturesMove(db, look, opts)
      : [];
  return {
    moved,
    after,
    /** The version appended. */
    versionId,
    statements: [
      db.insert(characterLookVersions).values({
        id: versionId,
        lookId: look.id,
        ...after,
        styling: stylingMoved ? after.styling : look.storedStyling,
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
      ...legacyMove,
    ],
  };
};

/**
 * The move (#2065), for the batch of the default-look styling edit that
 * causes it: the character's current bible version still holds legacy
 * features text, which the look's new styling now replaces, so a bible
 * version without it is appended and made current. Every sheet claim of
 * the character is revoked (the other looks stop reading that text), and a
 * `character.updated` event records the move when the write was made from
 * a sequence. Empty when the bible holds none.
 */
const legacyFeaturesMove = async (
  db: Database,
  look: { id: string },
  opts: {
    source: LookVersionSource;
    createdBy: string | null;
    sequenceId: string | null;
  }
): Promise<BatchItem<'sqlite'>[]> => {
  // ponytail: a character an older worker wrote before #1600 has no bible version to append to, so its legacy features stay joined; give it a version first if one ever turns up.
  const [current] = await db
    .select({ version: characterBibleVersions })
    .from(characterLooks)
    .innerJoin(characters, eq(characters.id, characterLooks.characterId))
    .innerJoin(
      characterBibleVersions,
      eq(characterBibleVersions.id, characters.selectedBibleVersionId)
    )
    .where(eq(characterLooks.id, look.id));
  if (!current?.version.legacyDistinguishingFeatures?.trim()) return [];
  const { version } = current;
  const versionId = generateId();
  return [
    db.insert(characterBibleVersions).values({
      ...version,
      id: versionId,
      legacyDistinguishingFeatures: null,
      source: opts.source,
      createdBy: opts.createdBy,
      createdAt: new Date(),
    }),
    db
      .update(characters)
      .set({ selectedBibleVersionId: versionId, updatedAt: new Date() })
      .where(eq(characters.id, version.characterId)),
    demoteCharacterSheetClaims(db, eq(characters.id, version.characterId)),
    ...(opts.sequenceId === null
      ? []
      : [
          buildEventInsert(db, {
            sequenceId: opts.sequenceId,
            actorId: opts.createdBy,
            kind: 'character.updated',
            targetType: 'character',
            targetId: version.characterId,
            summary: `Moved the features of ${version.name} to the default look`,
            data: {
              prevState: {},
              bibleVersion: { from: version.id, to: versionId },
            },
          }),
        ]),
  ];
};

/**
 * Two live looks of one character never share a name: the name is what a
 * person picks by, and what a re-analysis matches on.
 */
const requireFreeName = async (
  db: Database,
  teamId: string,
  characterId: string,
  name: string,
  exceptLookId: string | null
): Promise<void> => {
  const taken = await selectLooks(
    db,
    teamId,
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

export function createCharacterLooksMethods(db: Database, teamId: string) {
  type LookWriteOpts = { source: LookVersionSource; actorId: string | null };

  const methods = {
    getById: (id: string) => getLook(db, teamId, id),

    /** A character's default look: its id is the character's. */
    ensureDefault: (characterId: string) =>
      requireLook(db, teamId, characterId),

    /** A character's looks, default first. Removed ones only on request. */
    listByCharacter: async (
      characterId: string,
      options?: { includeRemoved?: boolean }
    ): Promise<CharacterLook[]> =>
      await selectLooks(
        db,
        teamId,
        and(
          eq(characterLooks.characterId, characterId),
          options?.includeRemoved
            ? undefined
            : sql`${characterLooks.deletedAt} IS NULL`
        ),
        lookOrder
      ),

    /**
     * The selected sheet of every look of these characters (#2065), removed
     * looks included. What the person lock reads. Chunked below D1's
     * 100-bound-parameter cap.
     */
    listCastSheetUrls: async (
      characterIds: readonly string[]
    ): Promise<{ characterId: string; url: string }[]> => {
      const sheets: { characterId: string; url: string }[] = [];
      for (let i = 0; i < characterIds.length; i += 80) {
        const rows = await db
          .selectDistinct({
            characterId: characters.id,
            url: characterSheetVariants.url,
          })
          .from(characterLooks)
          .innerJoin(characters, eq(characters.id, characterLooks.characterId))
          .innerJoin(
            characterSheetVariants,
            eq(characterSheetVariants.id, characterLooks.selectedSheetVersionId)
          )
          .where(
            and(
              eq(characters.teamId, teamId),
              inArray(characters.id, characterIds.slice(i, i + 80))
            )
          );
        for (const { characterId, url } of rows) {
          if (url) sheets.push({ characterId, url });
        }
      }
      return sheets;
    },

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
          ...(await selectLooks(
            db,
            teamId,
            inArray(characterLooks.characterId, characterIds.slice(i, i + 80)),
            lookOrder
          ))
        );
      return rows;
    },

    /** Definition history of one of the team's looks, newest first. */
    listVersions: async (lookId: string): Promise<CharacterLookVersion[]> =>
      await db
        .select(getTableColumns(characterLookVersions))
        .from(characterLookVersions)
        .where(
          and(
            eq(characterLookVersions.lookId, lookId),
            inArray(
              characterLookVersions.lookId,
              db
                .select({ id: characterLooks.id })
                .from(characterLooks)
                .innerJoin(
                  characters,
                  eq(characters.id, characterLooks.characterId)
                )
                .where(eq(characters.teamId, teamId))
            )
          )
        )
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
        .innerJoin(
          sequenceCast,
          eq(sequenceCast.characterId, characterLooks.characterId)
        )
        .innerJoin(characters, eq(characters.id, sequenceCast.characterId))
        .where(
          and(
            eq(sequenceCast.sequenceId, sequenceId),
            eq(characters.teamId, teamId)
          )
        )
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
      sequenceId: string,
      characterId: string,
      analysed: readonly {
        lookId: string;
        name: string;
        clothing: string;
        styling: string;
      }[]
    ): Promise<Record<string, string>> => {
      // A character another sequence has ever cast is linked, never synced
      // (#2050, #2065): decided here, on every call, so no payload flag
      // that went stale mid-run can reach her.
      if (await analysisMayNotRewrite(db, teamId, characterId, sequenceId)) {
        return await methods.linkFromAnalysis(
          sequenceId,
          characterId,
          analysed
        );
      }
      const opts = { source: 'analysis' as const, createdBy: null };
      const defaultLook = await requireLook(db, teamId, characterId);
      const owner = await ownerOf(db, teamId, sequenceId, characterId);
      const others = (
        await selectLooks(
          db,
          teamId,
          eq(characterLooks.characterId, characterId)
        )
      ).filter((row) => !row.isDefault);
      const write = async (
        look: CharacterLook,
        patch: Partial<LookDefinition>
      ) => {
        const { statements, versionId } = await lookDefinitionWrite(
          db,
          look,
          patch,
          { ...opts, sequenceId }
        );
        const [first, ...rest] = statements;
        if (!first || versionId === null) return;
        await db.batch([
          first,
          ...rest,
          buildEventInsert(db, {
            sequenceId,
            actorId: null,
            kind: 'look.updated',
            targetType: 'character',
            targetId: characterId,
            summary: `Re-analysed look ${patch.name ?? look.name} of ${owner.name}`,
            data: {
              lookId: look.id,
              lookVersion: { from: look.lookVersionId, to: versionId },
            },
          }),
        ]);
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
          newLookRow(db, {
            id,
            versionId,
            characterId,
            sortOrder: others.length + index,
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
        const worn = new Set(
          [
            ...(
              await loadSceneContextBySequenceFromDb(db, sequenceId)
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
              sequenceId,
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

    /**
     * Link a shared character's analysed looks (#2050) and say which look each
     * analysis id landed on. Nothing of hers is rewritten or removed: a look
     * named by id or by NAME (case-blind, among every live look she has) is
     * hers already; a name she does not have becomes a new look. The cast
     * link is revived if it was removed, as `create` revives an analysed
     * character.
     */
    linkFromAnalysis: async (
      sequenceId: string,
      characterId: string,
      analysed: readonly {
        lookId: string;
        name: string;
        clothing: string;
        styling: string;
      }[]
    ): Promise<Record<string, string>> => {
      const owner = await ownerOf(db, teamId, sequenceId, characterId);
      const own = await db
        .select({
          id: characterLooks.id,
          sortOrder: characterLooks.sortOrder,
          name: characterLookVersions.name,
        })
        .from(characterLooks)
        .innerJoin(
          characterLookVersions,
          eq(characterLookVersions.id, characterLooks.selectedLookVersionId)
        )
        .where(
          and(
            eq(characterLooks.characterId, characterId),
            isNull(characterLooks.deletedAt)
          )
        );
      const key = (name: string) => name.trim().toLowerCase();
      const ids: Record<string, string> = {};
      const statements: BatchItem<'sqlite'>[] = [
        db
          .update(sequenceCast)
          .set({ removedAt: null })
          .where(eq(sequenceCast.id, owner.castId)),
      ];
      let nextSort = Math.max(0, ...own.map((look) => look.sortOrder)) + 1;
      for (const look of analysed) {
        const existing =
          own.find((row) => row.id === look.lookId) ??
          own.find((row) => key(row.name) === key(look.name));
        if (existing) {
          ids[look.lookId] = existing.id;
          continue;
        }
        const id = generateId();
        const versionId = generateId();
        statements.push(
          newLookRow(db, {
            id,
            versionId,
            characterId,
            sortOrder: nextSort++,
          }),
          db.insert(characterLookVersions).values({
            id: versionId,
            lookId: id,
            name: look.name.trim() || DEFAULT_LOOK_NAME,
            clothing: look.clothing.trim() || null,
            styling: look.styling.trim() || null,
            source: 'analysis',
            createdBy: null,
          })
        );
        own.push({ id, sortOrder: nextSort, name: look.name });
        ids[look.lookId] = id;
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      return ids;
    },

    /**
     * Add a look to a character. It has no sheet until someone asks for one.
     * `sequenceId` is the sequence the write was made from, for its event;
     * null from the Characters page (#2065).
     */
    create: async (
      sequenceId: string | null,
      characterId: string,
      definition: LookDefinition,
      opts: LookWriteOpts
    ): Promise<CharacterLook> => {
      const owner = await eventOwner(db, teamId, sequenceId, characterId);
      // A character with no look yet gets its default first, so the new one
      // is never the only look and never mistaken for the default. It is
      // also the team check.
      await requireLook(db, teamId, characterId);
      await requireFreeName(db, teamId, characterId, definition.name, null);
      const [last] = await db
        .select({ sortOrder: characterLooks.sortOrder })
        .from(characterLooks)
        .where(eq(characterLooks.characterId, characterId))
        .orderBy(desc(characterLooks.sortOrder))
        .limit(1);
      const id = generateId();
      const versionId = generateId();
      const look = {
        id,
        versionId,
        characterId,
        sortOrder: (last?.sortOrder ?? 0) + 1,
      };
      const version = db.insert(characterLookVersions).values({
        id: versionId,
        lookId: id,
        ...definition,
        source: opts.source,
        createdBy: opts.actorId,
      });
      await db.batch([
        newLookRow(db, look),
        version,
        ...(owner === null || sequenceId === null
          ? []
          : [
              buildEventInsert(db, {
                sequenceId,
                actorId: opts.actorId,
                kind: 'look.created',
                targetType: 'character',
                targetId: characterId,
                summary: `Added look ${definition.name} to ${owner.name}`,
                data: { lookId: id, name: definition.name },
              }),
            ]),
      ]);
      return await requireLook(db, teamId, id);
    },

    /**
     * Edit a look: appends a version and moves the pointer, with a
     * `look.updated` event carrying the previous values when made from a
     * sequence. A change to clothing or styling revokes the look's sheet
     * claim (#1113); its sheet and the shots of the scenes that pick it, in
     * every sequence, read stale by derivation.
     */
    update: async (
      sequenceId: string | null,
      lookId: string,
      patch: Partial<LookDefinition>,
      opts: LookWriteOpts
    ): Promise<CharacterLook> => {
      const look = await requireLook(db, teamId, lookId);
      if (patch.name !== undefined) {
        await requireFreeName(
          db,
          teamId,
          look.characterId,
          patch.name,
          look.id
        );
      }
      const { moved, statements, versionId } = await lookDefinitionWrite(
        db,
        look,
        patch,
        { source: opts.source, createdBy: opts.actorId, sequenceId }
      );
      const [first, ...rest] = statements;
      if (!first || versionId === null) return look;
      const owner = await eventOwner(db, teamId, sequenceId, look.characterId);
      await db.batch([
        first,
        ...rest,
        ...(owner === null || sequenceId === null
          ? []
          : [
              buildEventInsert(db, {
                sequenceId,
                actorId: opts.actorId,
                kind: 'look.updated',
                targetType: 'character',
                targetId: look.characterId,
                summary: `Edited look ${patch.name ?? look.name} of ${owner.name}`,
                data: {
                  lookId,
                  prevState: Object.fromEntries(
                    moved.map((key) => [key, look[key]])
                  ),
                  prevLookVersionId: look.lookVersionId,
                  lookVersion: { from: look.lookVersionId, to: versionId },
                },
              }),
            ]),
      ]);
      return await requireLook(db, teamId, lookId);
    },

    /**
     * Re-point a look at one of its own earlier versions. Clothing or
     * styling moving with it revokes the sheet claim, like an edit.
     */
    selectVersion: async (
      sequenceId: string,
      lookId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<CharacterLook> => {
      const look = await requireLook(db, teamId, lookId);
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
      const owner = await ownerOf(db, teamId, sequenceId, look.characterId);
      // Version to version: the look's own stored styling (#2065), not the
      // effective one, which on a default look also holds the bible's.
      const sheetMoved =
        (version.clothing ?? null) !== (look.clothing ?? null) ||
        (version.styling ?? null) !== (look.storedStyling ?? null);
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
          sequenceId,
          actorId: opts.actorId,
          kind: 'look.version-selected',
          targetType: 'character',
          targetId: look.characterId,
          summary: `Selected a version of look ${version.name} of ${owner.name}`,
          data: {
            lookId,
            versionId,
            prevLookVersionId: look.lookVersionId,
            lookVersion: { from: look.lookVersionId, to: versionId },
          },
        }),
      ]);
      return await requireLook(db, teamId, lookId);
    },

    /**
     * Soft-remove a look (undoable). The default look is refused: every
     * character wears something. So is a look a scene still picks, in any
     * live sequence that casts the character: the error names the scenes of
     * `sequenceId`, or the titles of the others, and nothing is quietly
     * re-dressed. An archived sequence does not refuse: it casts nothing
     * while archived, and a scene that points at a removed look keeps
     * wearing it when the sequence comes back. Returns the timestamp for
     * the toast Undo.
     */
    remove: async (
      sequenceId: string | null,
      lookId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const look = await requireLook(db, teamId, lookId);
      if (look.isDefault) {
        throw new ValidationError('The default look cannot be removed.');
      }
      if (look.deletedAt) return look.deletedAt;
      const scenesWearing = async (inSequence: string) =>
        [...(await loadSceneContextBySequenceFromDb(db, inSequence)).values()]
          .filter(({ scene }) =>
            Object.values(scene.continuity?.characterLooks ?? {}).includes(
              lookId
            )
          )
          .sort((a, b) => a.scene.orderIndex - b.scene.orderIndex)
          .map(({ scene }) => `scene ${scene.orderIndex + 1}`);
      const wornIn = sequenceId === null ? [] : await scenesWearing(sequenceId);
      if (wornIn.length > 0) {
        throw new ConflictError(
          `${look.name} is worn in ${wornIn.join(', ')}. Pick another look there first.`
        );
      }
      const users = await db
        .select({ sequenceId: sequences.id, title: sequences.title })
        .from(sequenceCast)
        .innerJoin(sequences, eq(sequences.id, sequenceCast.sequenceId))
        .where(
          and(
            eq(sequenceCast.characterId, look.characterId),
            sequenceId === null ? undefined : ne(sequences.id, sequenceId),
            ne(sequences.status, 'archived'),
            sql`${sequenceCast.removedAt} IS NULL`
          )
        )
        .orderBy(asc(sequences.title), asc(sequences.id));
      const elsewhere: string[] = [];
      for (const user of users) {
        if ((await scenesWearing(user.sequenceId)).length > 0) {
          elsewhere.push(user.title);
        }
      }
      if (elsewhere.length > 0) {
        throw new ConflictError(
          `${look.name} is worn in ${elsewhere.join(', ')}. Pick another look there first.`
        );
      }
      const deletedAt = new Date();
      const removal = db
        .update(characterLooks)
        .set({ deletedAt, updatedAt: deletedAt })
        .where(eq(characterLooks.id, lookId));
      const owner = await eventOwner(db, teamId, sequenceId, look.characterId);
      await db.batch([
        removal,
        ...(owner === null || sequenceId === null
          ? []
          : [
              buildEventInsert(db, {
                sequenceId,
                actorId: opts.actorId,
                kind: 'look.removed',
                targetType: 'character',
                targetId: look.characterId,
                summary: `Removed look ${look.name} of ${owner.name}`,
                data: { lookId, name: look.name },
              }),
            ]),
      ]);
      return deletedAt;
    },

    /** Undo a remove. From no sequence (`null`, #2065) no event is written. */
    restore: async (
      sequenceId: string | null,
      lookId: string,
      opts: { actorId: string | null }
    ): Promise<CharacterLook> => {
      const look = await requireLook(db, teamId, lookId);
      if (!look.deletedAt) return look;
      await requireFreeName(db, teamId, look.characterId, look.name, look.id);
      const revive = db
        .update(characterLooks)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(eq(characterLooks.id, lookId));
      const owner = await eventOwner(db, teamId, sequenceId, look.characterId);
      await db.batch([
        revive,
        ...(owner === null || sequenceId === null
          ? []
          : [
              buildEventInsert(db, {
                sequenceId,
                actorId: opts.actorId,
                kind: 'look.restored',
                targetType: 'character',
                targetId: look.characterId,
                summary: `Restored look ${look.name} of ${owner.name}`,
                data: { lookId, name: look.name },
              }),
            ]),
      ]);
      return await requireLook(db, teamId, lookId);
    },

    /**
     * Take a look's sheet claim (#1113): mint the id the run's version row
     * will carry and point the claim at it. Last kickoff wins.
     *
     * Taken only while the inputs the run was snapshotted from still hold —
     * the look's current version, the character's current bible version,
     * and that bible version's talent (#1863). An edit that landed between
     * the snapshot and this write found no claim to revoke, so the claim is
     * not taken and the run parks its sheet as divergent. The id is
     * returned either way: the run still needs one.
     *
     * `markGenerating: false` leaves the status alone, for a caller whose own
     * write already set it.
     */
    claimSheet: async (
      lookId: string,
      snapshot: LookSheetSnapshot,
      opts: { markGenerating: boolean }
    ): Promise<{ versionId: string; held: boolean }> => {
      const look = await requireLook(db, teamId, lookId);
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
            eq(characterLooks.id, look.id),
            eq(characterLooks.selectedLookVersionId, snapshot.lookVersionId),
            sql`EXISTS ${db
              .select({ one: sql`1` })
              .from(characters)
              .where(
                and(
                  eq(characters.id, characterLooks.characterId),
                  // A payload a worker froze before #1600 names no bible
                  // version. Absent is "unknown", not "none", so that part
                  // of the guard is skipped.
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a payload frozen before #1600
                  snapshot.bibleVersionId === undefined
                    ? undefined
                    : sql`${characters.selectedBibleVersionId} IS ${snapshot.bibleVersionId}`,
                  sql`(SELECT ${characterBibleVersions.talentId} FROM ${characterBibleVersions} WHERE ${characterBibleVersions.id} = ${characters.selectedBibleVersionId}) IS ${snapshot.talentId}`
                )
              )}`
          )
        );
      return { versionId, held: (result.rowsAffected ?? 0) > 0 };
    },

    /**
     * `failSheetClaim` for a run that names no look (one queued before
     * #2015, which is failed on arrival): the claim is found by its own id.
     * Nothing is written unless that run still holds it.
     */
    failSheetClaimByVersion: async (
      versionId: string,
      error: string
    ): Promise<void> => {
      await db
        .update(characterLooks)
        .set({
          pendingPromoteSheetVersionId: null,
          sheetStatus: 'failed',
          sheetError: error,
          updatedAt: new Date(),
        })
        .where(eq(characterLooks.pendingPromoteSheetVersionId, versionId));
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
      const look = await requireLook(db, teamId, lookId);
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
            eq(characterLooks.id, look.id),
            versionId === null
              ? sql`${characterLooks.pendingPromoteSheetVersionId} IS NULL`
              : sql`(${characterLooks.pendingPromoteSheetVersionId} = ${versionId} OR ${characterLooks.pendingPromoteSheetVersionId} IS NULL)`
          )
        );
    },
  };
  return methods;
}
