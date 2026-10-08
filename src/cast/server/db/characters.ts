/**
 * Scoped Characters Sub-module
 * Character CRUD, sheet generation, talent assignment, and shot-character matching.
 *
 * A character belongs to the team; a sequence uses it through a cast link
 * (#2017). Every read here comes through that link and returns the character
 * as that sequence casts it — the script id, the removal, the pinned bible
 * and its talent under the names the character's own columns had.
 */

import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@/platform/server/db/client';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';
import type {
  BibleVersionSource,
  CharacterBible,
  CharacterWithSheet,
  Character,
  CharacterRow,
  CharacterVoice,
  CharacterVoiceVersionSource,
  LegacyCharacterBibleColumn,
  LegacyCharacterSheetColumn,
  LookVersionSource,
  CharacterWithTalent,
  Shot,
  NewCharacter,
  SheetStatus,
  VoicePreview,
  VoicePreviewUnusable,
  CharacterVoiceVersionStatus,
} from '@/platform/server/db/schema';
import {
  CHARACTER_BIBLE_FIELDS,
  DEFAULT_LOOK_NAME,
  characterBibleVersions,
  characterLookVersions,
  characterLooks,
  characterSheetVariants,
  characterVoiceVersions,
  characters,
  sequenceCast,
  sequenceCastLooks,
  sequences,
  shots,
  talent,
} from '@/platform/server/db/schema';
import { identityToken, nextIdentityToken } from '@/cast/bible-field';
import { voiceProviderOf } from '@/cast/seed-voice';
import { markPreviewUnusable } from '@/cast/voice';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import { generateId } from '@/platform/id';
import { isUniqueConstraintError } from '@/platform/server/db/scoped/divergent-insert';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import { typedEntries } from '@/platform/typed-object';
import { matchCharacterToShotTags } from '@/shots/scene-matching';
import {
  characterBibleChanged,
  characterBibleColumns,
  legacyBibleClothing,
  pickCharacterBible,
  mergeDefined,
} from './bible-versions';
import {
  createCharacterLooksMethods,
  deleteLooksOfCharacters,
  liveLookSheetVersionId,
  lookDefinitionWrite,
  requireLook,
} from './character-looks';
import {
  assertNameFree,
  castElsewhere,
  deleteCastStatements,
  heldElsewhere,
} from './sequence-cast';
import { demoteCharacterSheetClaims } from './sheet-claims';
import { pickedLook, wearLook } from '@/cast/character-looks';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';
import { CHARACTER_SHEET_BIBLE_FIELDS } from '@/shots/input-hash';

/** A new character's bible where the caller left a field out. */
const NEW_CHARACTER_BIBLE: Omit<CharacterBible, 'name'> = {
  age: null,
  gender: null,
  ethnicity: null,
  physicalDescription: null,
  distinguishingFeatures: null,
  personality: null,
  movement: null,
  voiceOnly: false,
  isPerson: true,
  consistencyTag: null,
};

/** The bible a {@link NewCharacter} carries, undefined where left out. */
const bibleOf = (data: NewCharacter): Partial<CharacterBible> => ({
  name: data.name,
  age: data.age,
  gender: data.gender,
  ethnicity: data.ethnicity,
  physicalDescription: data.physicalDescription,
  distinguishingFeatures: data.distinguishingFeatures,
  personality: data.personality,
  movement: data.movement,
  voiceOnly: data.voiceOnly,
  isPerson: data.isPerson,
  consistencyTag: data.consistencyTag,
});

/** A look version says who wrote it; a recast is a person's edit. */
const lookSource = (source: BibleVersionSource): LookVersionSource =>
  source === 'recast' ? 'edit' : source;

const mergeBible = (base: CharacterBible, patch: Partial<CharacterBible>) =>
  mergeDefined(base, patch, CHARACTER_BIBLE_FIELDS);

const touchesSheet = (fields: readonly (keyof CharacterBible)[]) =>
  fields.some((key) =>
    (CHARACTER_SHEET_BIBLE_FIELDS as readonly string[]).includes(key)
  );

/**
 * The user-editable character bible fields (#1108 Phase 2). Everything else on
 * the row (casting, sheet output, first-mention provenance) is owned by
 * dedicated paths. Editing any of these re-stales the character sheet and the
 * prompts that project them — purely by hash derivation.
 */
export type CharacterBibleUpdate = Partial<
  Pick<
    CharacterWithSheet,
    | 'name'
    | 'age'
    | 'gender'
    | 'ethnicity'
    | 'physicalDescription'
    | 'standardClothing'
    | 'distinguishingFeatures'
    | 'personality'
    | 'movement'
    | 'voiceOnly'
    | 'isPerson'
    | 'voiceDescription'
    | 'consistencyTag'
  >
>;

/**
 * A voice write (#1657): the selected `character_voice_versions` row's values
 * (#1788) plus `useVoice`, which the version records as `enabled`. `update`
 * refuses all four so a voice write cannot land without saying where it
 * came from: a new value goes through `updateVoice`, re-selecting an old row
 * through `selectVoiceVersion`.
 */
type CharacterVoiceUpdate = Partial<
  CharacterVoice & Pick<CharacterRow, 'useVoice'>
>;
/**
 * A character's own voice: the switch, the pointers and the selected
 * version's values. Read with no cast link, so it is the same answer for a
 * character in no sequence, one, or several (#2017).
 */
export type CharacterVoiceState = CharacterVoice &
  Pick<
    CharacterRow,
    | 'id'
    | 'useVoice'
    | 'selectedVoiceVersionId'
    | 'pendingPromoteVoiceVersionId'
  >;
const VOICE_FIELDS = [
  'voiceId',
  'voiceDescription',
  'voicePreviews',
  'useVoice',
] as const satisfies readonly (keyof CharacterVoiceUpdate)[];
/**
 * The row's own columns, minus `useVoice` (see {@link CharacterVoiceUpdate}),
 * the bible, which only moves through {@link appendBible} (#1600), and the
 * sheet state, which lives on the character's looks (#2015).
 */
type CharacterUpdate = Partial<
  Omit<
    typeof characters.$inferInsert,
    | 'useVoice'
    | LegacyCharacterBibleColumn
    | LegacyCharacterSheetColumn
    | 'selectedBibleVersionId'
    | 'teamId'
  >
>;

/**
 * The live sheet of a character with NO look (#2015) — one an older worker
 * wrote during the deploy. The explicit selection when there is one, else the
 * row the #1419 backfill keyed to the character's own id. Every other
 * character's sheet resolves through its default look.
 */
const legacyLiveSheetVersionId = sql`COALESCE(${characters.legacySelectedSheetVersionId}, ${characters.id})`;

// The row's own columns: the legacy bible and sheet state are read only
// through the fallbacks below.
const {
  legacyName: _name,
  legacyAge: _age,
  legacyGender: _gender,
  legacyEthnicity: _ethnicity,
  legacyPhysicalDescription: _physicalDescription,
  legacyStandardClothing: _standardClothing,
  legacyDistinguishingFeatures: _distinguishingFeatures,
  legacyPersonality: _personality,
  legacyMovement: _movement,
  legacyVoiceOnly: _voiceOnly,
  legacyIsPerson: _isPerson,
  legacyConsistencyTag: _consistencyTag,
  legacySheetStatus: _sheetStatus,
  legacySheetError: _sheetError,
  legacySelectedSheetVersionId: _selectedSheetVersionId,
  legacyPendingPromoteSheetVersionId: _pendingPromoteSheetVersionId,
  // The character's current version; a read carries the one its cast pins.
  selectedBibleVersionId: _currentBibleVersionId,
  ...characterRowColumns
} = getTableColumns(characters);

/**
 * The character as its sequence casts it (#2017). Needs the cast link and
 * the bible version it pins joined.
 */
const castColumns = {
  castId: sequenceCast.id,
  sequenceId: sequenceCast.sequenceId,
  characterId: sequenceCast.scriptCharacterId,
  selectedBibleVersionId: sequenceCast.bibleVersionId,
  talentId: characterBibleVersions.talentId,
  deletedAt: sequenceCast.removedAt,
};

/**
 * What a character with no look wears: the bible's old clothing and the
 * row's own sheet state (#2015). {@link resolveLooks} strips these.
 */
const legacyLookColumns = {
  legacyStandardClothing: legacyBibleClothing,
  legacySheetStatus: characters.legacySheetStatus,
  legacySheetError: characters.legacySheetError,
  legacySelectedSheetVersionId: characters.legacySelectedSheetVersionId,
  legacyPendingPromoteSheetVersionId:
    characters.legacyPendingPromoteSheetVersionId,
  legacySheetImageUrl: characterSheetVariants.url,
  legacySheetImagePath: characterSheetVariants.storagePath,
  legacySheetGeneratedAt: characterSheetVariants.generatedAt,
  legacySheetInputHash: characterSheetVariants.inputHash,
};

const characterColumns = {
  ...characterRowColumns,
  ...castColumns,
  // Null when the link pins a version that is not there; see resolveLooks.
  pinnedBibleVersionId: characterBibleVersions.id,
  ...characterBibleColumns,
  ...legacyLookColumns,
  // The voice IS the selected version row (#1788); all null without one.
  voiceId: characterVoiceVersions.voiceId,
  voiceDescription: characterVoiceVersions.description,
  voicePreviews: characterVoiceVersions.previews,
};

/** What `json_group_array` returns for one character's sequences. */
const teamCastSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    updatedAt: z.number(),
    sheetImageUrl: z.string().nullable(),
  })
);

/**
 * One of the team's characters as the team sees it (#2017): its current
 * bible, the library flag and the sequences that cast it. No sequence's pin
 * is read, so it answers for a character in no sequence, or in several.
 */
export type TeamCharacter = {
  id: string;
  name: string;
  physicalDescription: string | null;
  voiceOnly: boolean;
  inLibrary: boolean;
  /** When a sequence casting it last changed; null when none casts it. */
  lastUsedAt: Date | null;
  /**
   * The live sequences that cast it, the most recently changed first, each
   * with the default look's sheet as that sequence selected it.
   */
  sequences: { id: string; title: string; sheetImageUrl: string | null }[];
};

const RELEASED_VOICE_MESSAGE =
  'This voice was deleted when it stopped being used; design or pick a new one.';
const VOICE_HUSK_NOT_READY_MESSAGE =
  'This voice is not finished generating yet.';
const VOICE_HUSK_EMPTY_MESSAGE = 'This voice has no saved take.';
const VOICE_DESIGN_IN_FLIGHT_MESSAGE = 'Voice design already in flight';
const LIVE_VOICE_CLAIM_STATUSES = [
  'pending',
  'generating',
] as const satisfies readonly CharacterVoiceVersionStatus[];

/**
 * The saved voices that would be stranded if the characters `where` matches
 * (a condition on `characters`) were deleted: provider voice ids on ANY of
 * their voice versions, selected or not, that are not yet released and that
 * no surviving row still points at.
 *
 * - A history row with `releasedAt` null is the only record that a slot is
 *   still held (`releaseReplacedVoice` leaves one on purpose when the
 *   provider delete fails), so every version counts, not just the selected.
 * - A voice whose provider holds no slot is left out: that is
 *   `voiceProviderOf`'s call, not a prefix read here.
 * - "Still pointed at" is `getVoiceReferenceCount`'s rule: another
 *   character's selected version, or a talent.
 */
export async function voiceIdsHeldOnlyBy(
  db: Database,
  where: SQL
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ voiceId: characterVoiceVersions.voiceId })
    .from(characterVoiceVersions)
    .innerJoin(
      characters,
      eq(characters.id, characterVoiceVersions.characterId)
    )
    .where(
      sql`${where} and ${isNotNull(characterVoiceVersions.voiceId)} and ${isNull(characterVoiceVersions.releasedAt)}`
    );
  const ids = rows
    .map((row) => row.voiceId)
    .filter(
      (id): id is string => id !== null && voiceProviderOf(id) !== 'seed'
    );
  if (ids.length === 0) return [];
  // One bound parameter however many there are (D1 caps a statement at 100).
  const theirs = sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  const onSurvivors = await db
    .select({ voiceId: characterVoiceVersions.voiceId })
    .from(characters)
    .innerJoin(
      characterVoiceVersions,
      eq(characterVoiceVersions.id, characters.selectedVoiceVersionId)
    )
    .where(
      sql`NOT (${where}) and ${inArray(characterVoiceVersions.voiceId, theirs)}`
    );
  const onTalent = await db
    .select({ voiceId: talent.voiceId })
    .from(talent)
    .where(inArray(talent.voiceId, theirs));
  const kept = new Set([...onSurvivors, ...onTalent].map((row) => row.voiceId));
  return ids.filter((id) => !kept.has(id));
}

/**
 * Refuse a hard delete that would strand a saved voice. A saved voice is an
 * account-wide provider slot, freed only through `releaseVoiceIfUnreferenced`
 * (provider first, row second), which a db method cannot call. So the caller
 * reads {@link voiceIdsHeldOnlyBy}, runs each id through
 * `releaseVoiceIfUnreferenced` (after `releaseCharacterVoice` has dropped a
 * live pointer), and names the ids it handled. An id it did not name stops
 * the delete.
 *
 * The ids are named rather than re-read from `releasedAt`, because a release
 * does not always stamp it: a voice that takes no slot, an unconfigured or
 * refused key. Re-reading would refuse those deletes for good.
 */
export async function assertVoicesReleased(
  db: Database,
  where: SQL,
  releasedVoiceIds: readonly string[]
): Promise<void> {
  const owed = (await voiceIdsHeldOnlyBy(db, where)).filter(
    (id) => !releasedVoiceIds.includes(id)
  );
  if (owed.length > 0) {
    throw new ConflictError(
      `${owed.length} saved voice(s) would be stranded. Release each through releaseVoiceIfUnreferenced before deleting.`
    );
  }
}

/**
 * Hard-delete the characters `where` matches (a condition on `characters`)
 * and every row keyed to them, for the caller's own `db.batch`. Nothing
 * cascades from `characters` (#2017, the #612 rebuild trap), so the bible
 * versions, looks, look versions, sheet variants and voice versions go
 * first, here. The cast links and cast looks go before these
 * (`deleteCastStatements`): they hold the looks and the characters.
 */
export const deleteCharactersStatements = (db: Database, where: SQL) => {
  const theirs = db.select({ id: characters.id }).from(characters).where(where);
  return [
    db
      .delete(characterBibleVersions)
      .where(inArray(characterBibleVersions.characterId, theirs)),
    ...deleteLooksOfCharacters(db, where),
    db
      .delete(characterSheetVariants)
      .where(inArray(characterSheetVariants.characterId, theirs)),
    db
      .delete(characterVoiceVersions)
      .where(inArray(characterVoiceVersions.characterId, theirs)),
    db.delete(characters).where(where),
  ] as const;
};

export function createCharactersMethods(db: Database, teamId: string) {
  const looks = createCharacterLooksMethods(db, teamId);
  const inTeam = eq(characters.teamId, teamId);

  /**
   * The team's characters as their sequences cast them, and the joins they
   * depend on, looks not yet resolved. One row per cast link.
   */
  const selectRows = () =>
    db
      .select(characterColumns)
      .from(sequenceCast)
      .innerJoin(characters, eq(characters.id, sequenceCast.characterId))
      .leftJoin(
        characterBibleVersions,
        eq(characterBibleVersions.id, sequenceCast.bibleVersionId)
      )
      .leftJoin(
        characterSheetVariants,
        eq(characterSheetVariants.id, legacyLiveSheetVersionId)
      )
      .leftJoin(
        characterVoiceVersions,
        eq(characterVoiceVersions.id, characters.selectedVoiceVersionId)
      );
  type Row = Awaited<ReturnType<typeof selectRows>>[number];

  /**
   * Rows as every read returns them (#2015): each with its looks, wearing its
   * default — clothing and sheet under the names the character's own columns
   * had. A character with no look wears its legacy columns.
   */
  const resolveLooks = async (
    sequenceId: string,
    rows: readonly Row[]
  ): Promise<CharacterWithSheet[]> => {
    if (rows.length === 0) return [];
    const all = await looks.listByCharacters(
      sequenceId,
      rows.map((row) => row.id)
    );
    return rows.map((row) => {
      // The pin has no FK. A link that names a missing version has no bible
      // to read, and must not come back as a character with a blank one.
      if (row.pinnedBibleVersionId === null) {
        throw new Error(
          `Character ${row.id} pins bible version ${row.selectedBibleVersionId}, which does not exist`
        );
      }
      const {
        pinnedBibleVersionId: _pinned,
        legacyStandardClothing,
        legacySheetStatus,
        legacySheetError,
        legacySelectedSheetVersionId,
        legacyPendingPromoteSheetVersionId,
        legacySheetImageUrl,
        legacySheetImagePath,
        legacySheetGeneratedAt,
        legacySheetInputHash,
        ...character
      } = row;
      const own = all.filter((look) => look.characterId === row.id);
      const worn = own.find((look) => look.isDefault);
      if (worn) {
        return {
          ...wearLook({ ...character, looks: own }, worn),
          sheetImagePath: worn.sheetImagePath,
          sheetGeneratedAt: worn.sheetGeneratedAt,
          sheetError: worn.sheetError,
          pendingPromoteSheetVersionId: worn.pendingPromoteSheetVersionId,
        };
      }
      return {
        ...character,
        looks: own,
        lookId: row.id,
        lookName: DEFAULT_LOOK_NAME,
        standardClothing: legacyStandardClothing,
        styling: null,
        sheetStatus: legacySheetStatus,
        sheetError: legacySheetError,
        selectedSheetVersionId: legacySelectedSheetVersionId,
        pendingPromoteSheetVersionId: legacyPendingPromoteSheetVersionId,
        sheetImageUrl: legacySheetImageUrl,
        sheetImagePath: legacySheetImagePath,
        sheetGeneratedAt: legacySheetGeneratedAt,
        sheetInputHash: legacySheetInputHash,
      };
    });
  };

  /** The team's resolved characters as one sequence casts them. */
  const selectCharacters = async (
    sequenceId: string,
    where: SQL | undefined
  ): Promise<CharacterWithSheet[]> =>
    await resolveLooks(
      sequenceId,
      await selectRows().where(
        and(inTeam, eq(sequenceCast.sequenceId, sequenceId), where)
      )
    );

  /**
   * The character as one sequence casts it. A sequence links a character at
   * most once (unique index), so the sequence and the id name one row.
   */
  const castOf = async (
    sequenceId: string,
    id: string
  ): Promise<CharacterWithSheet | undefined> =>
    (await selectCharacters(sequenceId, eq(characters.id, id)))[0];

  /** Every script id a sequence's links use, removed ones included. */
  const scriptIdsOf = async (sequenceId: string): Promise<Set<string>> =>
    new Set(
      (
        await db
          .select({ scriptCharacterId: sequenceCast.scriptCharacterId })
          .from(sequenceCast)
          .where(eq(sequenceCast.sequenceId, sequenceId))
      ).map((row) => row.scriptCharacterId)
    );

  /** A write's row, re-read so it carries the resolved bible, looks and voice. */
  const reread = async (
    sequenceId: string,
    id: string
  ): Promise<CharacterWithSheet> => {
    const character = await castOf(sequenceId, id);
    if (!character) throw new Error(`SequenceCharacter ${id} not found`);
    return character;
  };

  /**
   * The character's own voice: its switch and the selected version's values.
   * No cast link is read, so it answers for a character in no sequence, or
   * in several.
   */
  const voiceOf = async (id: string): Promise<CharacterVoiceState> => {
    const [row] = await db
      .select({
        id: characters.id,
        useVoice: characters.useVoice,
        selectedVoiceVersionId: characters.selectedVoiceVersionId,
        pendingPromoteVoiceVersionId: characters.pendingPromoteVoiceVersionId,
        voiceId: characterVoiceVersions.voiceId,
        voiceDescription: characterVoiceVersions.description,
        voicePreviews: characterVoiceVersions.previews,
      })
      .from(characters)
      .leftJoin(
        characterVoiceVersions,
        eq(characterVoiceVersions.id, characters.selectedVoiceVersionId)
      )
      .where(and(eq(characters.id, id), inTeam));
    if (!row) throw new Error(`Character ${id} not found`);
    return row;
  };

  /**
   * The one writer of a bible (#1600): the statements that append a version
   * row, make it the character's current one and pin the sequence's cast
   * link to it (#2017), for the caller's own `db.batch`. The version carries
   * the cast talent, so every caller says who plays the character: a new
   * `talentId` is a recast, `existing.talentId` keeps the cast.
   * A change to a field the sheets read, or of the talent, revokes the
   * in-flight sheet claim of every look of that cast (#1113, #2015) in the
   * same batch. Empty when nothing moved.
   */
  const bibleWrite = (
    existing: Character,
    patch: Partial<CharacterBible>,
    opts: {
      source: BibleVersionSource;
      createdBy: string | null;
      talentId: string | null;
    }
  ) => {
    const before = pickCharacterBible(existing);
    const after = mergeBible(before, patch);
    const moved = characterBibleChanged(before, after);
    const { talentId } = opts;
    const talentMoved = talentId !== existing.talentId;
    if (moved.length === 0 && !talentMoved) {
      return { moved, talentMoved, statements: [] };
    }
    const versionId = generateId();
    return {
      moved,
      talentMoved,
      statements: [
        db.insert(characterBibleVersions).values({
          id: versionId,
          characterId: existing.id,
          ...after,
          talentId,
          source: opts.source,
          createdBy: opts.createdBy,
        }),
        db
          .update(characters)
          .set({ selectedBibleVersionId: versionId, updatedAt: new Date() })
          .where(eq(characters.id, existing.id)),
        db
          .update(sequenceCast)
          .set({ bibleVersionId: versionId })
          .where(eq(sequenceCast.id, existing.castId)),
        ...(touchesSheet(moved) || talentMoved
          ? [
              demoteCharacterSheetClaims(
                db,
                eq(sequenceCast.id, existing.castId)
              ),
            ]
          : []),
      ],
    };
  };

  // The character's own columns; no cast link is read or written. Voice
  // fields are NOT writable here — a new value goes through `updateVoice`,
  // which appends the history row and moves the pointer (#1657).
  const update = async (id: string, data: CharacterUpdate): Promise<void> => {
    // Belt for the non-literal call site TypeScript's excess-property check
    // cannot see (a spread, a widened variable): drizzle drops a key that is
    // not a column, so a voice write here would vanish without a trace.
    for (const key of VOICE_FIELDS) {
      if (key in data) {
        throw new Error(`Write ${key} through updateVoice, not update`);
      }
    }
    const [character] = await db
      .update(characters)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(characters.id, id), inTeam))
      .returning({ id: characters.id });

    if (!character) {
      throw new NotFoundError(`Character ${id} not found`);
    }
  };

  /**
   * How a NEW voice value lands (#1657): one `db.batch` that appends the
   * history row — the selected one's values with `data` on top — and points
   * the character at it. `source` says WHY — a release and a library pick
   * both used to be inferred as 'generated'. The other pointer writers:
   * `selectVoiceVersion` (re-selects an old row) and
   * `promoteVoiceClaimIfPending` (a finished Voice Design).
   */
  const updateVoice = async (
    id: string,
    data: CharacterVoiceUpdate,
    source: CharacterVoiceVersionSource,
    /** Who did this — required so no writer forgets; null when nobody did. */
    createdBy: string | null
  ): Promise<CharacterVoiceState> => {
    const existing = await voiceOf(id);
    const versionId = generateId();
    await db.batch([
      db.insert(characterVoiceVersions).values({
        id: versionId,
        characterId: id,
        voiceId: data.voiceId === undefined ? existing.voiceId : data.voiceId,
        description:
          data.voiceDescription === undefined
            ? existing.voiceDescription
            : data.voiceDescription,
        previews:
          data.voicePreviews === undefined
            ? existing.voicePreviews
            : data.voicePreviews,
        enabled:
          data.useVoice === undefined ? existing.useVoice : data.useVoice,
        source,
        createdBy,
      }),
      db
        .update(characters)
        .set({
          ...(data.useVoice === undefined ? {} : { useVoice: data.useVoice }),
          selectedVoiceVersionId: versionId,
          pendingPromoteVoiceVersionId: null,
          updatedAt: new Date(),
        })
        .where(eq(characters.id, id)),
    ]);
    return await voiceOf(id);
  };

  /** The live shots whose scene tags this character, optionally in one look. */
  const shotsOf = async (
    sequenceId: string,
    characterId: string,
    wearing?: string
  ): Promise<Shot[]> => {
    const character = await castOf(sequenceId, characterId);
    if (!character) return [];
    const [allShots, sceneContext] = await Promise.all([
      db
        .select()
        .from(shots)
        .where(
          and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
        ) as Promise<Shot[]>,
      loadSceneContextBySequenceFromDb(db, sequenceId),
    ]);
    return allShots.filter((shot) => {
      const continuity = resolveSceneForShot(shot, sceneContext).scene
        ?.continuity;
      if (!matchCharacterToShotTags(character, continuity?.characterTags ?? []))
        return false;
      if (wearing === undefined) return true;
      const picked = pickedLook(character, continuity?.characterLooks);
      return (picked?.id ?? character.lookId) === wearing;
    });
  };

  /**
   * The team's characters with the sequences that cast them, in ONE grouped
   * read over the cast links: nothing about a sequence is stored on the
   * character. A removed link and an archived sequence do not count.
   *
   * Order: the most recently changed sequence casting it, then how many
   * sequences cast it. A character nothing casts and the library does not
   * hold is as good as gone, and is left out.
   */
  const selectTeam = async (
    where: SQL | undefined
  ): Promise<TeamCharacter[]> => {
    const lastUsedAt = sql`max(${sequences.updatedAt})`;
    const castCount = sql`count(${sequences.id})`;
    const rows = await db
      .select({
        id: characters.id,
        inLibrary: characters.inLibrary,
        name: characterBibleColumns.name,
        physicalDescription: characterBibleColumns.physicalDescription,
        voiceOnly: characterBibleColumns.voiceOnly,
        lastUsedAt: lastUsedAt.mapWith(sequences.updatedAt),
        cast: sql<string>`json_group_array(json_object('id', ${sequences.id}, 'title', ${sequences.title}, 'updatedAt', ${sequences.updatedAt}, 'sheetImageUrl', ${characterSheetVariants.url})) FILTER (WHERE ${sequences.id} IS NOT NULL)`,
      })
      .from(characters)
      .leftJoin(
        characterBibleVersions,
        eq(characterBibleVersions.id, characters.selectedBibleVersionId)
      )
      .leftJoin(
        sequenceCast,
        and(
          eq(sequenceCast.characterId, characters.id),
          isNull(sequenceCast.removedAt)
        )
      )
      .leftJoin(
        sequences,
        and(
          eq(sequences.id, sequenceCast.sequenceId),
          ne(sequences.status, 'archived')
        )
      )
      .leftJoin(
        characterLooks,
        and(
          eq(characterLooks.characterId, characters.id),
          eq(characterLooks.isDefault, true)
        )
      )
      .leftJoin(
        sequenceCastLooks,
        and(
          eq(sequenceCastLooks.castId, sequenceCast.id),
          eq(sequenceCastLooks.lookId, characterLooks.id)
        )
      )
      .leftJoin(
        characterSheetVariants,
        eq(characterSheetVariants.id, liveLookSheetVersionId)
      )
      .where(and(inTeam, where))
      .groupBy(characters.id)
      .having(sql`${characters.inLibrary} OR ${castCount} > 0`)
      .orderBy(
        sql`${lastUsedAt} DESC NULLS LAST`,
        sql`${castCount} DESC`,
        asc(characterBibleColumns.name),
        asc(characters.id)
      );
    return rows.map(({ cast, ...row }) => ({
      ...row,
      sequences: teamCastSchema
        .parse(JSON.parse(cast))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ updatedAt: _updatedAt, ...sequence }) => sequence),
    }));
  };

  return {
    /**
     * The team's characters (#2017), sorted by use; see {@link selectTeam}.
     * `inLibrary: true` narrows them to the library.
     */
    // ponytail: the whole list in one read; page it when a team passes a few thousand characters.
    listTeam: async (opts: { inLibrary: boolean }): Promise<TeamCharacter[]> =>
      await selectTeam(
        opts.inLibrary ? eq(characters.inLibrary, true) : undefined
      ),

    /** One of the team's characters, with the sequences that cast it. */
    getTeamCharacter: async (id: string): Promise<TeamCharacter | null> =>
      (await selectTeam(eq(characters.id, id)))[0] ?? null,

    /**
     * Put the character in the team library, or take it out (#2017). A flag
     * on the character itself: nothing is copied, and no cast link moves.
     */
    setInLibrary: async (id: string, inLibrary: boolean): Promise<void> =>
      await update(id, { inLibrary }),

    /**
     * Cast one of the team's library characters into `sequenceId` (#2050):
     * one link pinning her current bible version, and a cast look per live
     * look, each pinned at its current version and sheet-less (a sheet also
     * depends on the sequence's style and image model). Nothing is copied.
     *
     * Refused unless the character is in the library, and while a live cast
     * member of the sequence already has her name: the script names a
     * character in capitals, and two of one name could not be told apart.
     * Attaching a character the sequence already casts is idempotent: a
     * removed link comes back, a live one is returned as it is.
     */
    attach: async (
      sequenceId: string,
      id: string,
      opts: { actorId: string | null }
    ): Promise<Character> => {
      const [character] = await db
        .select({
          inLibrary: characters.inLibrary,
          bibleVersionId: characterBibleVersions.id,
          name: characterBibleColumns.name,
        })
        .from(characters)
        .leftJoin(
          characterBibleVersions,
          eq(characterBibleVersions.id, characters.selectedBibleVersionId)
        )
        .where(and(eq(characters.id, id), inTeam));
      if (!character) throw new NotFoundError('Character not found');
      if (character.bibleVersionId === null || character.name === null) {
        throw new Error(
          `Character ${id} points at a bible version that does not exist`
        );
      }
      const { name } = character;
      if (!character.inLibrary) {
        throw new ValidationError(`${name} is not in the library`);
      }
      // The sequence must be this team's too: the db method refuses, not
      // only its callers.
      const [sequence] = await db
        .select({ id: sequences.id })
        .from(sequences)
        .where(and(eq(sequences.id, sequenceId), eq(sequences.teamId, teamId)));
      if (!sequence) throw new NotFoundError('Sequence not found');
      const existing = await castOf(sequenceId, id);
      if (existing) {
        if (!existing.deletedAt) return existing;
        await assertNameFree(db, sequenceId, name, id);
        await db
          .update(sequenceCast)
          .set({ removedAt: null })
          .where(eq(sequenceCast.id, existing.castId));
        return await reread(sequenceId, id);
      }
      await assertNameFree(db, sequenceId, name, null);
      // The script id follows a hand-added character's (`char_ada`), uniqued
      // against every link of the sequence, removed ones included.
      const scriptCharacterId = nextIdentityToken(
        identityToken('char', name),
        await scriptIdsOf(sequenceId)
      );
      const lookRows = await db
        .select({
          id: characterLooks.id,
          lookVersionId: characterLooks.selectedLookVersionId,
        })
        .from(characterLooks)
        .where(
          and(
            eq(characterLooks.characterId, id),
            isNull(characterLooks.deletedAt)
          )
        );
      const castId = generateId();
      await db.batch([
        db.insert(sequenceCast).values({
          id: castId,
          sequenceId,
          characterId: id,
          scriptCharacterId,
          bibleVersionId: character.bibleVersionId,
        }),
        ...lookRows.map((look) =>
          db.insert(sequenceCastLooks).values({
            castId,
            lookId: look.id,
            lookVersionId: look.lookVersionId,
            sheetStatus: 'pending',
          })
        ),
        buildEventInsert(db, {
          sequenceId,
          actorId: opts.actorId,
          kind: 'character.attached',
          targetType: 'character',
          targetId: id,
          summary: `Added ${name} from the library`,
          data: { name, characterId: scriptCharacterId },
        }),
      ]);
      return await reread(sequenceId, id);
    },

    /** The character as `sequenceId` casts it, live or removed. */
    getById: async (
      sequenceId: string,
      id: string
    ): Promise<CharacterWithSheet | null> => {
      return (await castOf(sequenceId, id)) ?? null;
    },

    /** The character's own voice; see {@link CharacterVoiceState}. */
    getVoice: async (id: string): Promise<CharacterVoiceState> =>
      await voiceOf(id),

    getByCharacterId: async (
      sequenceId: string,
      characterId: string
    ): Promise<CharacterWithSheet | null> => {
      const result = await selectCharacters(
        sequenceId,
        eq(sequenceCast.scriptCharacterId, characterId)
      );
      return result[0] ?? null;
    },

    // Default lists exclude soft-deleted rows (#1108): a deleted character
    // must vanish from the cast facet, the prompt-context bibles, and the
    // staleness verifies — all of which read through these methods. Restore
    // (or an id-addressed getById) is the only way back.
    list: async (
      sequenceId: string,
      page?: PageOptions
    ): Promise<CharacterWithSheet[]> => {
      return await resolveLooks(
        sequenceId,
        await pageOf(
          selectRows().$dynamic(),
          and(
            inTeam,
            eq(sequenceCast.sequenceId, sequenceId),
            isNull(sequenceCast.removedAt)
          ),
          characters.id,
          page
        )
      );
    },

    /** Soft-deleted characters of the sequence, most recently deleted first. */
    listDeleted: async (sequenceId: string): Promise<CharacterWithSheet[]> =>
      await resolveLooks(
        sequenceId,
        await selectRows()
          .where(
            and(
              inTeam,
              eq(sequenceCast.sequenceId, sequenceId),
              isNotNull(sequenceCast.removedAt)
            )
          )
          .orderBy(desc(sequenceCast.removedAt))
      ),

    /**
     * Every bible version of the sequence's cast, oldest first (#1600).
     * Staleness causes diff the version live when an artifact was made
     * against the live bible.
     */
    listBibleVersionsBySequence: async (sequenceId: string) =>
      await db
        .select(getTableColumns(characterBibleVersions))
        .from(characterBibleVersions)
        .innerJoin(
          sequenceCast,
          eq(sequenceCast.characterId, characterBibleVersions.characterId)
        )
        .where(eq(sequenceCast.sequenceId, sequenceId))
        .orderBy(
          asc(characterBibleVersions.createdAt),
          asc(characterBibleVersions.id)
        ),

    listWithTalent: async (
      sequenceId: string
    ): Promise<CharacterWithTalent[]> => {
      const results = await db
        .select({
          character: characterColumns,
          talent: {
            id: talent.id,
            name: talent.name,
            imageUrl: talent.imageUrl,
          },
        })
        .from(sequenceCast)
        .innerJoin(characters, eq(characters.id, sequenceCast.characterId))
        .leftJoin(
          characterBibleVersions,
          eq(characterBibleVersions.id, sequenceCast.bibleVersionId)
        )
        .leftJoin(talent, eq(characterBibleVersions.talentId, talent.id))
        .leftJoin(
          characterSheetVariants,
          eq(characterSheetVariants.id, legacyLiveSheetVersionId)
        )
        .leftJoin(
          characterVoiceVersions,
          eq(characterVoiceVersions.id, characters.selectedVoiceVersionId)
        )
        .where(
          and(
            inTeam,
            eq(sequenceCast.sequenceId, sequenceId),
            isNull(sequenceCast.removedAt)
          )
        );

      const resolved = await resolveLooks(
        sequenceId,
        results.map((row) => row.character)
      );
      return resolved.map((character, index) => {
        const cast = results[index]?.talent;
        return { ...character, talent: cast?.id ? cast : null };
      });
    },

    /** These characters as `sequenceId` casts them. */
    getByIds: async (
      sequenceId: string,
      ids: string[]
    ): Promise<CharacterWithSheet[]> => {
      if (ids.length === 0) return [];
      return await selectCharacters(sequenceId, inArray(characters.id, ids));
    },

    listWithSheets: async (
      sequenceId: string
    ): Promise<CharacterWithSheet[]> => {
      // A character counts once any of its looks has a finished sheet: a
      // scene may pick a look other than the default (#2015).
      const live = await selectCharacters(
        sequenceId,
        isNull(sequenceCast.removedAt)
      );
      // A look whose sheet is not finished offers none: a scene that wears
      // it attaches no sheet, exactly as a single-look character whose sheet
      // is not finished is left out. Its hash fields are untouched.
      const finished = <T extends { sheetStatus: SheetStatus }>(
        look: T
      ): T | (T & { sheetImageUrl: null }) =>
        look.sheetStatus === 'completed'
          ? look
          : { ...look, sheetImageUrl: null };
      return live
        .filter(
          (character) =>
            character.sheetStatus === 'completed' ||
            character.looks.some((look) => look.sheetStatus === 'completed')
        )
        .map((character) => ({
          ...finished(character),
          looks: character.looks.map(finished),
        }));
    },

    /**
     * Insert, or re-analyse onto, the character keyed by
     * `(sequenceId, characterId)`. The bible lands as a version row (#1600),
     * appended only when a field moved, so an identical re-analysis adds no
     * history and keeps an in-flight sheet claim. A move of a field the
     * sheets read, or of the cast talent, revokes every look's (#1113).
     *
     * `standardClothing` and `sheetStatus` are its default look's (#2015): a
     * new character gets one, under the character's own id, and a re-analysis
     * that moved the clothing appends a look version.
     */
    create: async (
      data: NewCharacter,
      opts: { source: BibleVersionSource; createdBy: string | null }
    ): Promise<Character> => {
      const [found] = await selectCharacters(
        data.sequenceId,
        eq(sequenceCast.scriptCharacterId, data.characterId)
      );
      // A character the library or another live sequence holds is never
      // written through analysis (#2050), whatever the payload said: a live
      // link is returned as it is (the looks module links, see
      // `syncFromAnalysis`), and a removed link stays removed — the entry
      // becomes a new character under the next free script id. Decided here,
      // on every call, so a snapshot that went stale mid-run cannot reach her.
      const held = found
        ? await heldElsewhere(db, teamId, found.id, data.sequenceId)
        : false;
      if (found && held && !found.deletedAt) {
        // The sheet status is this sequence's own (the cast look), not hers:
        // the references stage still marks her default look generating.
        if (data.sheetStatus !== undefined) {
          const defaultLook = await requireLook(
            db,
            teamId,
            data.sequenceId,
            found.lookId
          );
          await db
            .update(sequenceCastLooks)
            .set({ sheetStatus: data.sheetStatus, updatedAt: new Date() })
            .where(eq(sequenceCastLooks.id, defaultLook.castLookId));
          return await reread(data.sequenceId, found.id);
        }
        return found;
      }
      const existing = found && !held ? found : undefined;
      const scriptCharacterId =
        found && held
          ? nextIdentityToken(
              data.characterId,
              await scriptIdsOf(data.sequenceId)
            )
          : data.characterId;
      const {
        name: _n,
        age: _a,
        gender: _g,
        ethnicity: _e,
        physicalDescription: _pd,
        standardClothing: clothing,
        sheetStatus,
        distinguishingFeatures: _df,
        personality: _p,
        movement: _m,
        voiceOnly: _vo,
        isPerson: _ip,
        consistencyTag: _ct,
        voiceId: incomingVoiceId,
        voiceDescription: incomingVoiceDescription,
        sequenceId,
        characterId: _scriptCharacterId,
        talentId,
        ...row
      } = data;
      const look = {
        source: lookSource(opts.source),
        createdBy: opts.createdBy,
      };
      const id = existing?.id ?? data.id ?? generateId();
      if (existing) {
        // An existing character with no look yet (an older worker's) gets its
        // default filled in first.
        const defaultLook = await requireLook(
          db,
          teamId,
          sequenceId,
          existing.lookId
        );
        const now = new Date();
        await db.batch([
          // A re-analysis re-extracting a removed character revives it — the
          // script says the character exists again (#1108). Sheet OUTPUT is
          // not re-written here (#1419).
          db
            .update(sequenceCast)
            .set({ removedAt: null })
            .where(eq(sequenceCast.id, existing.castId)),
          db
            .update(characters)
            .set({ updatedAt: now })
            .where(eq(characters.id, id)),
          // A field left out keeps its value, as the column upsert did.
          // A talent left out keeps the cast; null uncasts.
          ...bibleWrite(existing, bibleOf(data), {
            ...opts,
            talentId: talentId === undefined ? existing.talentId : talentId,
          }).statements,
          // `sheetStatus` is the default look's: both callers pass an
          // explicit lifecycle value ('generating' for re-analysis,
          // 'pending' for a manual add).
          ...(sheetStatus === undefined
            ? []
            : [
                db
                  .update(sequenceCastLooks)
                  .set({ sheetStatus, updatedAt: now })
                  .where(eq(sequenceCastLooks.id, defaultLook.castLookId)),
              ]),
          ...lookDefinitionWrite(db, defaultLook, { clothing }, look)
            .statements,
        ]);
      } else {
        const bible = mergeBible(
          { ...NEW_CHARACTER_BIBLE, name: data.name },
          bibleOf(data)
        );
        const versionId = generateId();
        const lookVersionId = generateId();
        const castId = generateId();
        await db.batch([
          db.insert(characters).values({
            ...row,
            id,
            teamId,
            selectedBibleVersionId: versionId,
            legacyName: bible.name,
          }),
          db.insert(characterBibleVersions).values({
            id: versionId,
            characterId: id,
            ...bible,
            talentId: talentId ?? null,
            source: opts.source,
            createdBy: opts.createdBy,
          }),
          db.insert(sequenceCast).values({
            id: castId,
            sequenceId,
            characterId: id,
            scriptCharacterId,
            bibleVersionId: versionId,
          }),
          // The default look reuses the character's id, as the backfill's
          // do, so a character has one whoever wrote it.
          db.insert(characterLooks).values({
            id,
            characterId: id,
            isDefault: true,
            sortOrder: 0,
            selectedLookVersionId: lookVersionId,
            // NOT NULL until the column is dropped (#2017).
            legacySheetStatus: sheetStatus ?? 'pending',
          }),
          db.insert(characterLookVersions).values({
            id: lookVersionId,
            lookId: id,
            name: DEFAULT_LOOK_NAME,
            clothing: clothing ?? null,
            styling: null,
            ...look,
          }),
          db.insert(sequenceCastLooks).values({
            castId,
            lookId: id,
            lookVersionId,
            sheetStatus: sheetStatus ?? 'pending',
          }),
        ]);
      }
      const character = await reread(sequenceId, id);
      // The voice the cast arrived with fills only what the character does
      // not already have (#1553): re-writing a voice would orphan an
      // ElevenLabs slot. What lands is a history row (#1657) — the ORIGINAL
      // one for a new character, so the analysed / talent-copied voice can be
      // selected back — and an identical re-upsert appends nothing.
      const voicePatch: CharacterVoiceUpdate = {
        ...(!character.voiceId && incomingVoiceId
          ? { voiceId: incomingVoiceId }
          : {}),
        ...(!character.voiceDescription && incomingVoiceDescription
          ? { voiceDescription: incomingVoiceDescription }
          : {}),
      };
      if (Object.keys(voicePatch).length > 0) {
        await updateVoice(
          character.id,
          voicePatch,
          // A voice id only ever arrives as the cast talent's copy.
          voicePatch.voiceId ? 'library' : 'analysis',
          // Seeded by the cast-records step, not by a person.
          null
        );
        return await reread(sequenceId, id);
      }
      return character;
    },

    update,
    updateVoice,

    /**
     * Mark a parked take unpromotable without a new history row (#1709):
     * the selected voice does not change, only the preview JSON flag.
     */
    stampPreviewUnusable: async (
      id: string,
      generatedVoiceId: string,
      reason: VoicePreviewUnusable
    ): Promise<CharacterVoiceState> => {
      const existing = await voiceOf(id);
      const next = markPreviewUnusable(
        existing.voicePreviews ?? [],
        generatedVoiceId,
        reason
      );
      // No previews without a selected version: `next` is null then.
      const versionId = existing.selectedVoiceVersionId;
      if (!next || !versionId) return existing;
      await db.batch([
        db
          .update(characterVoiceVersions)
          .set({ previews: next })
          .where(eq(characterVoiceVersions.id, versionId)),
        db
          .update(characters)
          .set({ updatedAt: new Date() })
          .where(eq(characters.id, id)),
      ]);
      return await voiceOf(id);
    },

    /**
     * Stamp every history row holding this voice id — any character, any team,
     * the id belongs to the ElevenLabs account — the moment the id is deleted
     * at the provider (#1657). Older rows keep the dead id, so without this
     * mark selecting one would 404 at TTS. Write-only: the release path calls
     * it right after the provider delete succeeds.
     */
    markVoiceReleased: async (voiceId: string): Promise<void> => {
      await db
        .update(characterVoiceVersions)
        .set({ releasedAt: new Date() })
        .where(
          and(
            eq(characterVoiceVersions.voiceId, voiceId),
            isNull(characterVoiceVersions.releasedAt)
          )
        );
    },

    listVoiceVersions: async (characterId: string) =>
      await db
        .select()
        .from(characterVoiceVersions)
        .where(eq(characterVoiceVersions.characterId, characterId))
        .orderBy(
          desc(characterVoiceVersions.createdAt),
          desc(characterVoiceVersions.id)
        ),

    /**
     * Every voice a sequence's cast has had, and which one each live
     * character speaks in now — who a recorded turn was, and since when their
     * voice is the current one (#1802).
     */
    listVoiceHistoryBySequence: async (sequenceId: string) => {
      const rows = await db
        .select({
          characterId: characterVoiceVersions.characterId,
          voiceId: characterVoiceVersions.voiceId,
          createdAt: characterVoiceVersions.createdAt,
          current: sql<number>`(${characters.selectedVoiceVersionId} = ${characterVoiceVersions.id} and ${sequenceCast.removedAt} is null)`,
        })
        .from(characterVoiceVersions)
        .innerJoin(
          characters,
          eq(characters.id, characterVoiceVersions.characterId)
        )
        .innerJoin(sequenceCast, eq(sequenceCast.characterId, characters.id))
        .where(eq(sequenceCast.sequenceId, sequenceId));
      return rows.map((row) => ({ ...row, current: Boolean(row.current) }));
    },

    /** The husk this run holds, including after it completed in place (#1715). */
    getVoiceVersionById: async (id: string) => {
      const [row] = await db
        .select()
        .from(characterVoiceVersions)
        .where(eq(characterVoiceVersions.id, id));
      return row ?? null;
    },

    selectVoiceVersion: async (
      characterId: string,
      versionId: string
    ): Promise<CharacterVoiceState> => {
      const [version] = await db
        .select()
        .from(characterVoiceVersions)
        .where(
          and(
            eq(characterVoiceVersions.id, versionId),
            eq(characterVoiceVersions.characterId, characterId)
          )
        );
      if (!version)
        throw new NotFoundError(
          `Voice version ${versionId} not found for character ${characterId}`
        );
      // The id on a released row no longer exists at ElevenLabs, so selecting
      // it would put a dead voice on the row and 404 at TTS (#1657).
      if (version.releasedAt) throw new ValidationError(RELEASED_VOICE_MESSAGE);
      if (version.status !== 'completed') {
        throw new ValidationError(VOICE_HUSK_NOT_READY_MESSAGE);
      }
      if (!version.voiceId) {
        throw new ValidationError(VOICE_HUSK_EMPTY_MESSAGE);
      }
      // The released check rides in the write too: a release landing between
      // the read above and here must not leave a dead id selected.
      const [updated] = await db
        .update(characters)
        .set({
          useVoice: version.enabled,
          selectedVoiceVersionId: version.id,
          pendingPromoteVoiceVersionId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(characters.id, characterId),
            inTeam,
            exists(
              db
                .select({ id: characterVoiceVersions.id })
                .from(characterVoiceVersions)
                .where(
                  and(
                    eq(characterVoiceVersions.id, version.id),
                    isNull(characterVoiceVersions.releasedAt),
                    eq(characterVoiceVersions.status, 'completed')
                  )
                )
            )
          )
        )
        .returning({ id: characters.id });
      if (!updated) throw new Error(RELEASED_VOICE_MESSAGE);
      return await voiceOf(characterId);
    },

    /**
     * Rows (any team — the id is the ElevenLabs account's) still pointing at
     * a voice — a character through its selected version (#1788), a talent
     * through its own column — soft-deleted characters included:
     * soft-delete stamps `deletedAt` and THEN releases (provider first, row
     * second), so a deleted row still holding an id is a release that
     * failed, and the voice it names is still on the account. `get` prefix
     * on purpose: it is a read, so the workflow surface strips it.
     */
    getVoiceReferenceCount: async (voiceId: string): Promise<number> => {
      const [chars] = await db
        .select({ n: count() })
        .from(characters)
        .innerJoin(
          characterVoiceVersions,
          eq(characterVoiceVersions.id, characters.selectedVoiceVersionId)
        )
        .where(eq(characterVoiceVersions.voiceId, voiceId));
      const [tal] = await db
        .select({ n: count() })
        .from(talent)
        .where(eq(talent.voiceId, voiceId));
      return (chars?.n ?? 0) + (tal?.n ?? 0);
    },

    /**
     * The saved voices a hard delete of this character would strand: release
     * each, then pass them to `delete`. `get` prefix on purpose: it is a
     * read, so the workflow surface strips it.
     */
    getVoiceIdsToRelease: async (id: string): Promise<string[]> =>
      await voiceIdsHeldOnlyBy(db, sql`${eq(characters.id, id)} and ${inTeam}`),

    /**
     * Hard-delete one of the team's characters with everything keyed to it.
     * Every statement names the team's character, so another team's id
     * deletes nothing. Refused while a saved voice would be stranded:
     * `releasedVoiceIds` are the ids from {@link getVoiceIdsToRelease} the
     * caller has run through `releaseVoiceIfUnreferenced`
     * ({@link assertVoicesReleased}).
     */
    delete: async (
      id: string,
      opts: { releasedVoiceIds: readonly string[] }
    ): Promise<boolean> => {
      const mine = sql`${eq(characters.id, id)} and ${inTeam}`;
      await assertVoicesReleased(db, mine, opts.releasedVoiceIds);
      // Two cast statements, then six for the character; the last is its own.
      const [, , , , , , , result] = await db.batch([
        ...deleteCastStatements(
          db,
          inArray(
            sequenceCast.characterId,
            db.select({ id: characters.id }).from(characters).where(mine)
          )
        ),
        ...deleteCharactersStatements(db, mine),
      ]);
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    /**
     * Insert a generating Voice Design husk (#1715). Does not complete it —
     * that is `completeVoiceClaimIfLive`. A unique live claim returns the
     * existing row with `created: false` so enqueue/bible can no-op or adopt.
     */
    createPendingVoiceClaim: async (
      characterId: string,
      createdBy: string | null,
      opts?: { workflowRunId?: string | null }
    ) => {
      const existing = await voiceOf(characterId);
      const versionId = generateId();
      try {
        const [versionRows, characterRows] = await db.batch([
          db
            .insert(characterVoiceVersions)
            .values({
              id: versionId,
              characterId,
              source: 'generated',
              status: 'generating',
              createdBy,
              workflowRunId: opts?.workflowRunId ?? null,
              description: existing.voiceDescription,
              enabled: existing.useVoice,
            })
            .returning(),
          db
            .update(characters)
            .set({
              pendingPromoteVoiceVersionId: versionId,
              updatedAt: new Date(),
            })
            .where(eq(characters.id, characterId))
            .returning(),
        ]);
        const version = versionRows[0];
        if (!version || !characterRows[0]) {
          throw new Error(
            `Failed to insert pending voice claim for character ${characterId}`
          );
        }
        return { version, created: true as const };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          const [live] = await db
            .select()
            .from(characterVoiceVersions)
            .where(
              and(
                eq(characterVoiceVersions.characterId, characterId),
                inArray(characterVoiceVersions.status, [
                  ...LIVE_VOICE_CLAIM_STATUSES,
                ])
              )
            );
          if (live) return { version: live, created: false as const };
          throw new Error(VOICE_DESIGN_IN_FLIGHT_MESSAGE);
        }
        throw error;
      }
    },

    listLiveVoiceClaims: async (characterId: string) =>
      await db
        .select()
        .from(characterVoiceVersions)
        .where(
          and(
            eq(characterVoiceVersions.characterId, characterId),
            inArray(characterVoiceVersions.status, [
              ...LIVE_VOICE_CLAIM_STATUSES,
            ])
          )
        ),

    completeVoiceClaimIfLive: async (
      versionId: string,
      data: {
        voiceId?: string | null;
        description?: string | null;
        previews?: VoicePreview[] | null;
      }
    ) => {
      const [row] = await db
        .update(characterVoiceVersions)
        .set({
          ...(data.voiceId !== undefined ? { voiceId: data.voiceId } : {}),
          ...(data.description !== undefined
            ? { description: data.description }
            : {}),
          ...(data.previews !== undefined ? { previews: data.previews } : {}),
          status: 'completed',
          error: null,
        })
        .where(
          and(
            eq(characterVoiceVersions.id, versionId),
            inArray(characterVoiceVersions.status, [
              ...LIVE_VOICE_CLAIM_STATUSES,
            ])
          )
        )
        .returning();
      return row ?? null;
    },

    markVoiceClaimTerminal: async (
      versionId: string,
      status: Extract<CharacterVoiceVersionStatus, 'failed'>,
      error?: string
    ) => {
      const [row] = await db
        .update(characterVoiceVersions)
        .set({ status, error: error ?? null })
        .where(
          and(
            eq(characterVoiceVersions.id, versionId),
            inArray(characterVoiceVersions.status, [
              ...LIVE_VOICE_CLAIM_STATUSES,
            ])
          )
        )
        .returning();
      if (row) {
        await db
          .update(characters)
          .set({
            pendingPromoteVoiceVersionId: null,
            updatedAt: new Date(),
          })
          .where(eq(characters.pendingPromoteVoiceVersionId, versionId));
      }
      return row ?? null;
    },

    /**
     * Select the husk as the live voice only if auto-promote still names it.
     * Returns null when the user picked something else mid-run (#1070 analog).
     */
    promoteVoiceClaimIfPending: async (
      characterId: string,
      versionId: string
    ) => {
      const [version] = await db
        .select()
        .from(characterVoiceVersions)
        .where(
          and(
            eq(characterVoiceVersions.id, versionId),
            eq(characterVoiceVersions.characterId, characterId)
          )
        );
      if (!version || version.status !== 'completed' || !version.voiceId) {
        return null;
      }
      const [updated] = await db
        .update(characters)
        .set({
          useVoice: version.enabled,
          selectedVoiceVersionId: version.id,
          pendingPromoteVoiceVersionId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(characters.id, characterId),
            eq(characters.pendingPromoteVoiceVersionId, versionId)
          )
        )
        .returning({ id: characters.id });
      return updated ? await voiceOf(characterId) : null;
    },

    stampVoiceClaimWorkflowRunId: async (
      versionId: string,
      workflowRunId: string
    ) => {
      const [row] = await db
        .update(characterVoiceVersions)
        .set({ workflowRunId })
        .where(eq(characterVoiceVersions.id, versionId))
        .returning();
      return row ?? null;
    },

    getNeedingSheets: async (
      sequenceId: string
    ): Promise<CharacterWithSheet[]> => {
      const live = await selectCharacters(
        sequenceId,
        isNull(sequenceCast.removedAt)
      );
      return live.filter(
        (character) =>
          character.sheetStatus === 'pending' ||
          character.sheetStatus === 'failed'
      );
    },

    /**
     * User edit of the bible fields (#1108 Phase 2), committing the update and
     * a `character.updated` event (with the previous values of the changed
     * fields, for undo/audit) in one `db.batch()`. Staleness follows purely by
     * derivation: the sheet hash and the prompt hashes embed these fields, so
     * verifies flip to 'stale' with no flag written here.
     *
     * A recast is the same write (#2017): ONE version carrying the new talent
     * and the appearance copied from it. The cast talent feeds every look's
     * sheet, so a recast revokes the sheet claims even when the talent did
     * not move (#1113, #2015).
     */
    updateBible: async (
      sequenceId: string,
      id: string,
      data: CharacterBibleUpdate,
      opts: { actorId: string | null } & (
        | { /** A person's form or API edit. */ source: 'edit' }
        | {
            /** A talent cast; `talentId` null uncasts. */
            source: 'recast';
            talentId: string | null;
          }
      )
    ): Promise<Character> => {
      const existing = await castOf(sequenceId, id);
      if (!existing) {
        throw new Error(`SequenceCharacter ${id} not found`);
      }
      const prev: Record<string, string | boolean | null> = {};
      for (const [key, value] of typedEntries(data)) {
        if (value === undefined) continue;
        prev[key] = existing[key] ?? null;
      }
      // A character an older worker wrote keeps its clothing on the legacy
      // bible column, which the version appended below no longer carries
      // (#2015): give it its default look first.
      const defaultLook = await requireLook(
        db,
        teamId,
        sequenceId,
        existing.lookId
      );
      const { voiceDescription, standardClothing, ...bibleData } = data;
      // Appends a version and moves the pointer (#1600); an edit to a field
      // the sheet reads also revokes an in-flight sheet run's claim (#1113).
      const { statements } = bibleWrite(existing, bibleData, {
        source: opts.source,
        createdBy: opts.actorId,
        talentId: opts.source === 'recast' ? opts.talentId : existing.talentId,
      });
      // Clothing is the default look's (#2015): the same edit, written as a
      // look version.
      const look =
        standardClothing === undefined
          ? { statements: [] }
          : lookDefinitionWrite(
              db,
              defaultLook,
              { clothing: standardClothing },
              { source: lookSource(opts.source), createdBy: opts.actorId }
            );
      await db.batch([
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'character.updated',
          targetType: 'character',
          targetId: id,
          summary: `${opts.source === 'recast' ? 'Recast' : 'Edited'} character ${data.name ?? existing.name}`,
          data: { prevState: prev },
        }),
        ...statements,
        ...look.statements,
        ...(opts.source === 'recast'
          ? [
              demoteCharacterSheetClaims(
                db,
                eq(sequenceCast.id, existing.castId)
              ),
            ]
          : []),
      ]);
      // `voiceDescription` is the selected voice version's, so an edit to it
      // is a voice write and belongs in the voice history (#1657). Only when it
      // actually moved: the form posts every field, and a row per unrelated
      // bible edit would bury the real takes.
      if (
        voiceDescription !== undefined &&
        voiceDescription !== existing.voiceDescription
      ) {
        await updateVoice(id, { voiceDescription }, 'user-edit', opts.actorId);
      }
      return await reread(sequenceId, id);
    },

    /**
     * Soft-remove from the sequence (undoable): stamp the cast link + a
     * `character.deleted` event in one batch. Scene continuity tags are NOT
     * touched (plan §1 — lossless undo); prompts that referenced the character
     * read stale by derivation because the bible reads above exclude the row.
     * Returns the timestamp for the toast Undo. No-ops (returns the existing
     * timestamp) when already deleted.
     */
    softDelete: async (
      sequenceId: string,
      id: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const existing = await castOf(sequenceId, id);
      if (!existing) {
        throw new Error(`SequenceCharacter ${id} not found`);
      }
      if (existing.deletedAt) return existing.deletedAt;
      const deletedAt = new Date();
      await db.batch([
        db
          .update(sequenceCast)
          .set({ removedAt: deletedAt })
          .where(eq(sequenceCast.id, existing.castId)),
        db
          .update(characters)
          .set({ updatedAt: deletedAt })
          .where(eq(characters.id, id)),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'character.deleted',
          targetType: 'character',
          targetId: id,
          summary: `Removed character ${existing.name}`,
          data: { name: existing.name, characterId: existing.characterId },
        }),
      ]);
      return deletedAt;
    },

    /** Undo a soft delete (clears the link's `removedAt`), with a matching event. */
    restore: async (
      sequenceId: string,
      id: string,
      opts: { actorId: string | null }
    ): Promise<Character> => {
      const existing = await castOf(sequenceId, id);
      if (!existing) {
        throw new Error(`SequenceCharacter ${id} not found`);
      }
      // A character added since the remove may have taken the name (#2050).
      await assertNameFree(db, sequenceId, existing.name, id);
      const now = new Date();
      await db.batch([
        db
          .update(characters)
          .set({ updatedAt: now })
          .where(eq(characters.id, id)),
        db
          .update(sequenceCast)
          .set({ removedAt: null })
          .where(eq(sequenceCast.id, existing.castId)),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'character.restored',
          targetType: 'character',
          targetId: id,
          summary: `Restored character ${existing.name}`,
          data: { name: existing.name },
        }),
      ]);
      return await reread(sequenceId, id);
    },

    /**
     * Whether something other than `sequenceId` still holds the character:
     * the library, or another sequence casting it ({@link castElsewhere}).
     * What a sequence may not take with it when it lets the character go
     * (its voice).
     */
    getHeldElsewhere: async (
      sequenceId: string,
      id: string
    ): Promise<boolean> => await heldElsewhere(db, teamId, id, sequenceId),

    /**
     * Whether any sequence casts the character ({@link castElsewhere}). What
     * the library must not let go of without its voice being released.
     */
    getCastInAnySequence: async (id: string): Promise<boolean> => {
      const [row] = await db
        .select({ cast: sql<number>`${castElsewhere(id, null)}` })
        .from(characters)
        .where(and(eq(characters.id, id), inTeam));
      if (!row) throw new NotFoundError(`Character ${id} not found`);
      return Boolean(row.cast);
    },

    getShotsForCharacter: async (
      sequenceId: string,
      characterId: string
    ): Promise<Shot[]> => await shotsOf(sequenceId, characterId),

    /**
     * The shots a character is in. `wearing` narrows them to the scenes that
     * dress it in that look (#2015) — its default where a scene picks none.
     */
    getShotIdsForCharacter: async (
      sequenceId: string,
      characterId: string,
      opts?: { wearing: string }
    ): Promise<string[]> =>
      (await shotsOf(sequenceId, characterId, opts?.wearing)).map(
        (shot) => shot.id
      ),
  };
}
