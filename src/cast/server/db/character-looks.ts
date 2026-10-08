/**
 * Scoped Character Looks Sub-module (#2015)
 *
 * A look is an outfit on one character: an identity row, append-only
 * definition versions, and its own sheet with a claim. The look owns clothing;
 * "the character's sheet" is its default look's sheet.
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
  sequenceCastLooks,
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
 * A look's live sheet version in the sequence that uses it (#2017): the cast
 * look's explicit selection, else — for a default look only — the row the
 * #1419 backfill keyed to the character's own id. That pointer stays NULL on
 * purpose (it feeds the shot hash as `selectedSheetVersionId ??
 * sheetInputHash`), and the #2015 and #2017 backfills copied the NULL across
 * with it.
 */
export const liveLookSheetVersionId = sql`COALESCE(${sequenceCastLooks.selectedSheetVersionId}, CASE WHEN ${characterLooks.isDefault} THEN ${characterLooks.characterId} END)`;

// The look's own columns: its current version pointer and the legacy
// per-sequence state are not part of a read (#2017).
const {
  selectedLookVersionId: _pointer,
  legacySelectedSheetVersionId: _selectedSheetVersionId,
  legacyPendingPromoteSheetVersionId: _pendingPromoteSheetVersionId,
  legacySheetStatus: _sheetStatus,
  legacySheetError: _sheetError,
  ...lookRowColumns
} = getTableColumns(characterLooks);

const lookColumns = {
  ...lookRowColumns,
  // What the sequence decides (#2017): the pinned version and the sheet.
  castLookId: sequenceCastLooks.id,
  selectedSheetVersionId: sequenceCastLooks.selectedSheetVersionId,
  pendingPromoteSheetVersionId: sequenceCastLooks.pendingPromoteSheetVersionId,
  sheetStatus: sequenceCastLooks.sheetStatus,
  sheetError: sequenceCastLooks.sheetError,
  lookVersionId: characterLookVersions.id,
  // The look's current version, next to the pin, so a read can tell "a newer
  // version exists" without a second query.
  currentLookVersionId: characterLooks.selectedLookVersionId,
  name: characterLookVersions.name,
  clothing: characterLookVersions.clothing,
  styling: characterLookVersions.styling,
  // The pinned bible version's legacy features (#2065); see resolveStyling.
  legacyFeatures: legacyBibleFeatures,
  sheetImageUrl: characterSheetVariants.url,
  sheetImagePath: characterSheetVariants.storagePath,
  sheetGeneratedAt: characterSheetVariants.generatedAt,
  sheetInputHash: characterSheetVariants.inputHash,
};

/**
 * A look row as every read returns it (#2065): `styling` resolved through
 * `effectiveStyling` — on the default look, its own joined with the legacy
 * features text of the bible version read beside it — and the version's own
 * column kept as `storedStyling`.
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
 * The team's looks as ONE sequence uses them (#2017): each joined to that
 * sequence's cast look, and to the version that pins. A look the sequence
 * does not use is not returned, nor is another team's. A sequence links a
 * character once and a cast holds a look once, so a look comes back once.
 */
const selectLooks = async (
  db: Database,
  teamId: string,
  sequenceId: string,
  where: SQL | undefined,
  order: readonly SQL[] = []
): Promise<CharacterLook[]> =>
  (await selectLookRows(db, teamId, sequenceId, where).orderBy(...order)).map(
    resolveStyling
  );

const selectLookRows = (
  db: Database,
  teamId: string,
  sequenceId: string,
  where: SQL | undefined
) =>
  db
    .select(lookColumns)
    .from(characterLooks)
    .innerJoin(characters, eq(characters.id, characterLooks.characterId))
    .innerJoin(
      sequenceCastLooks,
      eq(sequenceCastLooks.lookId, characterLooks.id)
    )
    .innerJoin(sequenceCast, eq(sequenceCast.id, sequenceCastLooks.castId))
    .innerJoin(
      characterLookVersions,
      eq(characterLookVersions.id, sequenceCastLooks.lookVersionId)
    )
    .leftJoin(
      characterBibleVersions,
      eq(characterBibleVersions.id, sequenceCast.bibleVersionId)
    )
    .leftJoin(
      characterSheetVariants,
      eq(characterSheetVariants.id, liveLookSheetVersionId)
    )
    .where(
      and(
        eq(characters.teamId, teamId),
        eq(sequenceCast.sequenceId, sequenceId),
        where
      )
    );

/**
 * A look as the team has it (#2065): at its CURRENT version, with no
 * sequence's pin or sheet. What the Characters page edits while no sequence
 * casts the character.
 */
export type TeamLook = LookDefinition &
  Pick<CharacterLook, 'id' | 'characterId' | 'isDefault' | 'deletedAt'> & {
    /** The look's current version. */
    lookVersionId: string;
    /** That version's own `styling` column; see `CharacterLook`. */
    storedStyling: string | null;
  };

/**
 * The team's looks at their current versions; no cast look is read. A
 * deleted character's looks are not returned, so no write from no sequence
 * reaches them.
 */
const selectCurrentLooks = async (
  db: Database,
  teamId: string,
  where: SQL | undefined,
  order: readonly SQL[] = []
): Promise<TeamLook[]> =>
  (await selectCurrentLookRows(db, teamId, where).orderBy(...order)).map(
    resolveStyling
  );

const selectCurrentLookRows = (
  db: Database,
  teamId: string,
  where: SQL | undefined
) =>
  db
    .select({
      id: characterLooks.id,
      characterId: characterLooks.characterId,
      isDefault: characterLooks.isDefault,
      deletedAt: characterLooks.deletedAt,
      lookVersionId: characterLookVersions.id,
      name: characterLookVersions.name,
      clothing: characterLookVersions.clothing,
      styling: characterLookVersions.styling,
      legacyFeatures: legacyBibleFeatures,
    })
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
    .where(
      and(eq(characters.teamId, teamId), isNull(characters.deletedAt), where)
    );

/** Default first, then the order they were added. */
const lookOrder = [
  desc(characterLooks.isDefault),
  asc(characterLooks.sortOrder),
  asc(characterLooks.id),
];

/**
 * Give a character an older worker wrote during the #2015 deploy its default
 * look, from the legacy columns that backfill read, and that look's cast look
 * on the character's cast link (#2017). The ids are the character's own, as
 * the backfills' are, so a race inserts nothing twice. Nothing is written for
 * a character that already has a default look, or has no cast link yet.
 */
const backfillDefaultLook = async (
  db: Database,
  teamId: string,
  sequenceId: string,
  characterId: string
): Promise<void> => {
  const rows = await db
    .select({
      id: characters.id,
      castId: sequenceCast.id,
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
    .innerJoin(sequenceCast, eq(sequenceCast.characterId, characters.id))
    .leftJoin(
      characterBibleVersions,
      eq(characterBibleVersions.id, sequenceCast.bibleVersionId)
    )
    .where(
      and(
        eq(characters.id, characterId),
        eq(characters.teamId, teamId),
        eq(sequenceCast.sequenceId, sequenceId),
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
        // NOT NULL until the column is dropped (#2017).
        legacySheetStatus: legacy.sheetStatus,
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
    db
      .insert(sequenceCastLooks)
      .values({
        id: legacy.id,
        castId: legacy.castId,
        lookId: legacy.id,
        lookVersionId: legacy.id,
        selectedSheetVersionId: legacy.selectedSheetVersionId,
        pendingPromoteSheetVersionId: legacy.pendingPromoteSheetVersionId,
        sheetStatus: legacy.sheetStatus,
        sheetError: legacy.sheetError,
      })
      .onConflictDoNothing(),
  ]);
};

const getLook = async (
  db: Database,
  teamId: string,
  sequenceId: string,
  id: string
): Promise<CharacterLook | null> =>
  (await selectLooks(db, teamId, sequenceId, eq(characterLooks.id, id)))[0] ??
  null;

/**
 * The look a write is about to touch, as `sequenceId` uses it. A character
 * with no look yet answers to its own id (the id its default look takes), so
 * that case is filled in here rather than at every writer.
 */
export const requireLook = async (
  db: Database,
  teamId: string,
  sequenceId: string,
  id: string
): Promise<CharacterLook> => {
  const found = await getLook(db, teamId, sequenceId, id);
  if (found) return found;
  await backfillDefaultLook(db, teamId, sequenceId, id);
  const look = await getLook(db, teamId, sequenceId, id);
  if (!look) throw new NotFoundError(`Look ${id} not found`);
  return look;
};

/**
 * A character's looks at their current versions, default first, removed
 * ones included (`deletedAt`), as a cast read's `looks` are.
 */
export const currentLooksOf = async (
  db: Database,
  teamId: string,
  characterId: string
): Promise<TeamLook[]> =>
  await selectCurrentLooks(
    db,
    teamId,
    eq(characterLooks.characterId, characterId),
    lookOrder
  );

/** The look a write from no sequence is about to touch. */
const requireCurrentLook = async (
  db: Database,
  teamId: string,
  id: string
): Promise<TeamLook> => {
  const [look] = await selectCurrentLooks(
    db,
    teamId,
    eq(characterLooks.id, id)
  );
  if (!look) throw new NotFoundError(`Look ${id} not found`);
  return look;
};

/**
 * The look behind one `sequence_cast_looks` row, as its sequence uses it
 * (#2017): how a sheet row that names the cast look it was drawn for finds
 * the look it now belongs to, after a one-off copy repointed that cast look.
 */
export const getLookByCastLookId = async (
  db: Database,
  teamId: string,
  sequenceId: string,
  castLookId: string
): Promise<CharacterLook | null> =>
  (
    await selectLooks(
      db,
      teamId,
      sequenceId,
      eq(sequenceCastLooks.id, castLookId)
    )
  )[0] ?? null;

/**
 * A character's cast link in one sequence (#2017): where its looks' cast
 * looks go, and the name its events carry.
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
      eq(characterBibleVersions.id, sequenceCast.bibleVersionId)
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

/** A new look's own row, for the caller's own `db.batch`. */
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
    // NOT NULL until the column is dropped (#2017).
    legacySheetStatus: 'pending',
  });

/**
 * A new look and the cast look of the sequence adding it, for the caller's
 * own `db.batch`. It has no sheet until someone asks for one.
 */
const newLookStatements = (
  db: Database,
  look: {
    id: string;
    versionId: string;
    characterId: string;
    castId: string;
    sortOrder: number;
  }
) =>
  [
    newLookRow(db, look),
    db.insert(sequenceCastLooks).values({
      castId: look.castId,
      lookId: look.id,
      lookVersionId: look.versionId,
      sheetStatus: 'pending',
    }),
  ] as const;

/**
 * The one writer of a look's definition: the statements that append a
 * version, make it the look's current one and pin the sequence to it
 * (#2017), for the caller's own `db.batch`. A change to clothing or styling
 * revokes the in-flight sheet claim (#1113) in the same batch; a rename does
 * not. Empty when nothing moved. `castLookId` null is a write made from no
 * sequence (#2065): only the look's current pointer moves.
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
    castLookId: string | null;
  },
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
    /** The version appended; the event names the pin move from → to. */
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
        .set({ selectedLookVersionId: versionId, updatedAt: new Date() })
        .where(eq(characterLooks.id, look.id)),
      ...(look.castLookId === null
        ? []
        : [
            db
              .update(sequenceCastLooks)
              .set({
                lookVersionId: versionId,
                ...(touchesSheet ? { pendingPromoteSheetVersionId: null } : {}),
                updatedAt: new Date(),
              })
              .where(eq(sequenceCastLooks.id, look.castLookId)),
          ]),
      ...legacyMove,
    ],
  };
};

/**
 * The move (#2065), for the batch of the default-look styling edit that
 * causes it: the bible version the write reads from still holds legacy
 * features text, which the look's new styling now replaces, so a bible
 * version without it is appended, made current and pinned. Every sheet
 * claim of the cast is revoked (the other looks stop reading that text),
 * and a `character.updated` event records the pin move for the staleness
 * causes. Empty when the bible holds none. `castLookId` null is a write
 * from no sequence: the character's current version moves, no pin.
 */
const legacyFeaturesMove = async (
  db: Database,
  look: { id: string; castLookId: string | null },
  opts: { source: LookVersionSource; createdBy: string | null }
): Promise<BatchItem<'sqlite'>[]> => {
  // ponytail: a character an older worker wrote before #1600 has no bible version to append to, so its legacy features stay joined; give it a version first if one ever turns up.
  const [pinned] =
    look.castLookId === null
      ? await db
          .select({
            version: characterBibleVersions,
            castId: sql<null>`NULL`,
            // Never read: no cast, so no event.
            sequenceId: sql<string>`''`,
          })
          .from(characterLooks)
          .innerJoin(characters, eq(characters.id, characterLooks.characterId))
          .innerJoin(
            characterBibleVersions,
            eq(characterBibleVersions.id, characters.selectedBibleVersionId)
          )
          .where(eq(characterLooks.id, look.id))
      : await db
          .select({
            version: characterBibleVersions,
            castId: sequenceCast.id,
            sequenceId: sequenceCast.sequenceId,
          })
          .from(sequenceCastLooks)
          .innerJoin(
            sequenceCast,
            eq(sequenceCast.id, sequenceCastLooks.castId)
          )
          .innerJoin(
            characterBibleVersions,
            eq(characterBibleVersions.id, sequenceCast.bibleVersionId)
          )
          .where(eq(sequenceCastLooks.id, look.castLookId));
  if (!pinned?.version.legacyDistinguishingFeatures?.trim()) return [];
  const { version, castId, sequenceId } = pinned;
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
    ...(castId === null
      ? []
      : [
          db
            .update(sequenceCast)
            .set({ bibleVersionId: versionId })
            .where(eq(sequenceCast.id, castId)),
          demoteCharacterSheetClaims(db, eq(sequenceCast.id, castId)),
          buildEventInsert(db, {
            sequenceId,
            actorId: opts.createdBy,
            kind: 'character.updated',
            targetType: 'character',
            targetId: version.characterId,
            summary: `Moved the features of ${version.name} to the default look`,
            data: {
              prevState: {},
              // The pin move (#2017): the staleness causes walk these back.
              bibleVersion: { from: version.id, to: versionId },
            },
          }),
        ]),
  ];
};

/**
 * Two live looks of one character never share a name: the name is what a
 * person picks by, and what a re-analysis matches on. Among the looks
 * `sequenceId` uses; among all of the character's, at their current
 * versions, from no sequence.
 */
const requireFreeName = async (
  db: Database,
  teamId: string,
  sequenceId: string | null,
  characterId: string,
  name: string,
  exceptLookId: string | null
): Promise<void> => {
  const live = and(
    eq(characterLooks.characterId, characterId),
    sql`${characterLooks.deletedAt} IS NULL`
  );
  const taken: readonly { id: string; name: string }[] =
    sequenceId === null
      ? await selectCurrentLooks(db, teamId, live)
      : await selectLooks(db, teamId, sequenceId, live);
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
 * before it, in the same batch — and after the cast looks that RESTRICT the
 * looks' (`deleteCastStatements`).
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

  /**
   * Add a look to a character. It has no sheet until someone asks for one.
   * `sequenceId` null is a write made from no sequence (#2065, the
   * Characters page): the look and its first version only, no cast look and
   * no event.
   */
  async function create(
    sequenceId: string,
    characterId: string,
    definition: LookDefinition,
    opts: LookWriteOpts
  ): Promise<CharacterLook>;
  async function create(
    sequenceId: null,
    characterId: string,
    definition: LookDefinition,
    opts: LookWriteOpts
  ): Promise<TeamLook>;
  async function create(
    sequenceId: string | null,
    characterId: string,
    definition: LookDefinition,
    opts: LookWriteOpts
  ): Promise<CharacterLook | TeamLook> {
    const owner =
      sequenceId === null
        ? null
        : await ownerOf(db, teamId, sequenceId, characterId);
    // A character with no look yet gets its default first, so the new one
    // is never the only look and never mistaken for the default. From no
    // sequence the default must already be there: it is also the team check.
    if (sequenceId === null) await requireCurrentLook(db, teamId, characterId);
    else await requireLook(db, teamId, sequenceId, characterId);
    await requireFreeName(
      db,
      teamId,
      sequenceId,
      characterId,
      definition.name,
      null
    );
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
    if (sequenceId === null || owner === null) {
      await db.batch([newLookRow(db, look), version]);
      return await requireCurrentLook(db, teamId, id);
    }
    await db.batch([
      ...newLookStatements(db, { ...look, castId: owner.castId }),
      version,
      buildEventInsert(db, {
        sequenceId,
        actorId: opts.actorId,
        kind: 'look.created',
        targetType: 'character',
        targetId: characterId,
        summary: `Added look ${definition.name} to ${owner.name}`,
        data: { lookId: id, name: definition.name },
      }),
    ]);
    return await requireLook(db, teamId, sequenceId, id);
  }

  /**
   * Edit a look: appends a version and moves the pointer, with a
   * `look.updated` event carrying the previous values. A change to
   * clothing or styling revokes the look's sheet claim (#1113); its sheet
   * and the shots of the scenes that pick it read stale by derivation.
   * `sequenceId` null is a write made from no sequence (#2065): the version
   * and the look's current pointer only. No pin moves and no event is written.
   */
  async function update(
    sequenceId: string,
    lookId: string,
    patch: Partial<LookDefinition>,
    opts: LookWriteOpts
  ): Promise<CharacterLook>;
  async function update(
    sequenceId: null,
    lookId: string,
    patch: Partial<LookDefinition>,
    opts: LookWriteOpts
  ): Promise<TeamLook>;
  async function update(
    sequenceId: string | null,
    lookId: string,
    patch: Partial<LookDefinition>,
    opts: LookWriteOpts
  ): Promise<CharacterLook | TeamLook> {
    if (sequenceId === null) {
      const current = await requireCurrentLook(db, teamId, lookId);
      if (patch.name !== undefined) {
        await requireFreeName(
          db,
          teamId,
          null,
          current.characterId,
          patch.name,
          current.id
        );
      }
      const [head, ...tail] = (
        await lookDefinitionWrite(db, { ...current, castLookId: null }, patch, {
          source: opts.source,
          createdBy: opts.actorId,
        })
      ).statements;
      if (!head) return current;
      await db.batch([head, ...tail]);
      return await requireCurrentLook(db, teamId, lookId);
    }
    const look = await requireLook(db, teamId, sequenceId, lookId);
    if (patch.name !== undefined) {
      await requireFreeName(
        db,
        teamId,
        sequenceId,
        look.characterId,
        patch.name,
        look.id
      );
    }
    const { moved, statements, versionId } = await lookDefinitionWrite(
      db,
      look,
      patch,
      { source: opts.source, createdBy: opts.actorId }
    );
    const [first, ...rest] = statements;
    if (!first || versionId === null) return look;
    const owner = await ownerOf(db, teamId, sequenceId, look.characterId);
    await db.batch([
      first,
      ...rest,
      buildEventInsert(db, {
        sequenceId,
        actorId: opts.actorId,
        kind: 'look.updated',
        targetType: 'character',
        targetId: look.characterId,
        summary: `Edited look ${patch.name ?? look.name} of ${owner.name}`,
        data: {
          lookId,
          prevState: Object.fromEntries(moved.map((key) => [key, look[key]])),
          prevLookVersionId: look.lookVersionId,
          // The pin move (#2017): the staleness causes walk these back.
          lookVersion: { from: look.lookVersionId, to: versionId },
        },
      }),
    ]);
    return await requireLook(db, teamId, sequenceId, lookId);
  }

  /** Undo a remove. From no sequence (`null`, #2065) no event is written. */
  async function restore(
    sequenceId: string,
    lookId: string,
    opts: { actorId: string | null }
  ): Promise<CharacterLook>;
  async function restore(
    sequenceId: null,
    lookId: string,
    opts: { actorId: string | null }
  ): Promise<TeamLook>;
  async function restore(
    sequenceId: string | null,
    lookId: string,
    opts: { actorId: string | null }
  ): Promise<CharacterLook | TeamLook> {
    const look =
      sequenceId === null
        ? await requireCurrentLook(db, teamId, lookId)
        : await requireLook(db, teamId, sequenceId, lookId);
    if (!look.deletedAt) return look;
    await requireFreeName(
      db,
      teamId,
      sequenceId,
      look.characterId,
      look.name,
      look.id
    );
    const revive = db
      .update(characterLooks)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(characterLooks.id, lookId));
    if (sequenceId === null) {
      await revive;
      return await requireCurrentLook(db, teamId, lookId);
    }
    const owner = await ownerOf(db, teamId, sequenceId, look.characterId);
    await db.batch([
      revive,
      buildEventInsert(db, {
        sequenceId,
        actorId: opts.actorId,
        kind: 'look.restored',
        targetType: 'character',
        targetId: look.characterId,
        summary: `Restored look ${look.name} of ${owner.name}`,
        data: { lookId, name: look.name },
      }),
    ]);
    return await requireLook(db, teamId, sequenceId, lookId);
  }

  const methods = {
    /** The look as `sequenceId` uses it. */
    getById: (sequenceId: string, id: string) =>
      getLook(db, teamId, sequenceId, id),

    /** A character's default look: its id is the character's. */
    ensureDefault: (sequenceId: string, characterId: string) =>
      requireLook(db, teamId, sequenceId, characterId),

    /**
     * A character's looks as `sequenceId` uses them, default first. Removed
     * ones only on request.
     */
    listByCharacter: async (
      sequenceId: string,
      characterId: string,
      options?: { includeRemoved?: boolean }
    ): Promise<CharacterLook[]> =>
      await selectLooks(
        db,
        teamId,
        sequenceId,
        and(
          eq(characterLooks.characterId, characterId),
          options?.includeRemoved
            ? undefined
            : sql`${characterLooks.deletedAt} IS NULL`
        ),
        lookOrder
      ),

    /**
     * The selected sheet of every look of these characters in every
     * sequence that casts them (#2065), whatever the state of the look, the
     * link or the sequence: removed and archived ones still count. What the
     * person lock reads. Chunked below D1's 100-bound-parameter cap.
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
          .from(sequenceCastLooks)
          .innerJoin(
            characterLooks,
            eq(characterLooks.id, sequenceCastLooks.lookId)
          )
          .innerJoin(characters, eq(characters.id, characterLooks.characterId))
          .innerJoin(
            characterSheetVariants,
            eq(
              characterSheetVariants.id,
              sequenceCastLooks.selectedSheetVersionId
            )
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
      sequenceId: string,
      characterIds: readonly string[]
    ): Promise<CharacterLook[]> => {
      const rows: CharacterLook[] = [];
      for (let i = 0; i < characterIds.length; i += 80)
        rows.push(
          ...(await selectLooks(
            db,
            teamId,
            sequenceId,
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
          sequenceCastLooks,
          eq(sequenceCastLooks.lookId, characterLookVersions.lookId)
        )
        .innerJoin(sequenceCast, eq(sequenceCast.id, sequenceCastLooks.castId))
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
      const defaultLook = await requireLook(
        db,
        teamId,
        sequenceId,
        characterId
      );
      const owner = await ownerOf(db, teamId, sequenceId, characterId);
      const others = (
        await selectLooks(
          db,
          teamId,
          sequenceId,
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
          opts
        );
        const [first, ...rest] = statements;
        if (!first || versionId === null) return;
        // The pin moved: the staleness causes walk these events back to the
        // version a shot was made from (#2017).
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
          ...newLookStatements(db, {
            id,
            versionId,
            characterId,
            castId: owner.castId,
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
     * named by id or by NAME (case-blind, among every live look she has, cast
     * here or not) gets a cast look in this sequence if it lacks one, pinned
     * at the look's current version; a name she does not have becomes a new
     * look. The cast link is revived if it was removed, as `create` revives
     * an analysed character.
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
          versionId: characterLooks.selectedLookVersionId,
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
          statements.push(
            db
              .insert(sequenceCastLooks)
              .values({
                castId: owner.castId,
                lookId: existing.id,
                lookVersionId: existing.versionId,
                sheetStatus: 'pending',
              })
              .onConflictDoNothing()
          );
          continue;
        }
        const id = generateId();
        const versionId = generateId();
        statements.push(
          ...newLookStatements(db, {
            id,
            versionId,
            characterId,
            castId: owner.castId,
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
        own.push({ id, versionId, sortOrder: nextSort, name: look.name });
        ids[look.lookId] = id;
      }
      const [first, ...rest] = statements;
      if (first) await db.batch([first, ...rest]);
      return ids;
    },

    create,
    update,

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
      const look = await requireLook(db, teamId, sequenceId, lookId);
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
          .set({ selectedLookVersionId: version.id, updatedAt: new Date() })
          .where(eq(characterLooks.id, lookId)),
        db
          .update(sequenceCastLooks)
          .set({
            lookVersionId: version.id,
            ...(sheetMoved ? { pendingPromoteSheetVersionId: null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(sequenceCastLooks.id, look.castLookId)),
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
            // The pin move (#2017): the staleness causes walk these back.
            lookVersion: { from: look.lookVersionId, to: versionId },
          },
        }),
      ]);
      return await requireLook(db, teamId, sequenceId, lookId);
    },

    /**
     * Soft-remove a look (undoable). The default look is refused: every
     * character wears something. So is a look a scene still picks: the
     * error names the scenes, and nothing is quietly re-dressed. Returns the
     * timestamp for the toast Undo. From no sequence (`null`, #2065) every
     * sequence that uses the look is checked and no event is written.
     */
    remove: async (
      sequenceId: string | null,
      lookId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const look =
        sequenceId === null
          ? await requireCurrentLook(db, teamId, lookId)
          : await requireLook(db, teamId, sequenceId, lookId);
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
      // The removal is the look's own, so it reaches every sequence that
      // uses the look (#2017): one of them still wearing it refuses too, and
      // is named. An archived sequence does not refuse: it casts nothing
      // while archived, and a scene that points at a removed look keeps
      // wearing it when the sequence comes back.
      const users = await db
        .select({ sequenceId: sequences.id, title: sequences.title })
        .from(sequenceCastLooks)
        .innerJoin(sequenceCast, eq(sequenceCast.id, sequenceCastLooks.castId))
        .innerJoin(sequences, eq(sequences.id, sequenceCast.sequenceId))
        .where(
          and(
            eq(sequenceCastLooks.lookId, lookId),
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
      if (sequenceId === null) {
        await removal;
        return deletedAt;
      }
      const owner = await ownerOf(db, teamId, sequenceId, look.characterId);
      await db.batch([
        removal,
        buildEventInsert(db, {
          sequenceId,
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

    restore,

    /**
     * Take a look's sheet claim (#1113), on the cast look of the sequence
     * that uses it (#2017): mint the id the run's version row will carry and
     * point the claim at it. Last kickoff wins.
     *
     * Taken only while the inputs the run was snapshotted from still hold —
     * the look version and bible version the sequence pins, and that bible
     * version's talent (#1863). An edit
     * that landed between the snapshot and this write found no claim to
     * revoke, so the claim is not taken and the run parks its sheet as
     * divergent. The id is returned either way: the run still needs one.
     *
     * `markGenerating: false` leaves the status alone, for a caller whose own
     * write already set it.
     */
    claimSheet: async (
      sequenceId: string,
      lookId: string,
      snapshot: LookSheetSnapshot,
      opts: { markGenerating: boolean }
    ): Promise<{ versionId: string; held: boolean }> => {
      const look = await requireLook(db, teamId, sequenceId, lookId);
      const versionId = generateId();
      const result = await db
        .update(sequenceCastLooks)
        .set({
          pendingPromoteSheetVersionId: versionId,
          ...(opts.markGenerating
            ? { sheetStatus: 'generating' as const, sheetError: null }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sequenceCastLooks.id, look.castLookId),
            eq(sequenceCastLooks.lookVersionId, snapshot.lookVersionId),
            sql`EXISTS ${db
              .select({ one: sql`1` })
              .from(sequenceCast)
              .where(
                and(
                  eq(sequenceCast.id, sequenceCastLooks.castId),
                  // A payload a worker froze before #1600 names no bible
                  // version. Absent is "unknown", not "none", so that part
                  // of the guard is skipped.
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a payload frozen before #1600
                  snapshot.bibleVersionId === undefined
                    ? undefined
                    : sql`${sequenceCast.bibleVersionId} IS ${snapshot.bibleVersionId}`,
                  sql`(SELECT ${characterBibleVersions.talentId} FROM ${characterBibleVersions} WHERE ${characterBibleVersions.id} = ${sequenceCast.bibleVersionId}) IS ${snapshot.talentId}`
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
        .update(sequenceCastLooks)
        .set({
          pendingPromoteSheetVersionId: null,
          sheetStatus: 'failed',
          sheetError: error,
          updatedAt: new Date(),
        })
        .where(eq(sequenceCastLooks.pendingPromoteSheetVersionId, versionId));
    },

    /**
     * A sheet run failed (#1113): clear its claim and mark the sheet failed —
     * only while it still holds the claim, or nobody does. A newer run's claim
     * and its `generating` status are left alone. `versionId` is null for a
     * run queued before #1113, which holds no claim.
     */
    failSheetClaim: async (
      sequenceId: string,
      lookId: string,
      versionId: string | null,
      error: string
    ): Promise<void> => {
      const look = await requireLook(db, teamId, sequenceId, lookId);
      await db
        .update(sequenceCastLooks)
        .set({
          pendingPromoteSheetVersionId: null,
          sheetStatus: 'failed',
          sheetError: error,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sequenceCastLooks.id, look.castLookId),
            versionId === null
              ? sql`${sequenceCastLooks.pendingPromoteSheetVersionId} IS NULL`
              : sql`(${sequenceCastLooks.pendingPromoteSheetVersionId} = ${versionId} OR ${sequenceCastLooks.pendingPromoteSheetVersionId} IS NULL)`
          )
        );
    },
  };
  return methods;
}
