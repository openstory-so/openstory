/**
 * Scoped Characters Sub-module
 * Character CRUD, sheet generation, talent assignment, and shot-character matching.
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
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
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
  shots,
  talent,
} from '@/platform/server/db/schema';
import { markPreviewUnusable } from '@/cast/voice';
import { NotFoundError, ValidationError } from '@/platform/errors';
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
  lookDefinitionWrite,
  requireLook,
} from './character-looks';
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
  ...characterRowColumns
} = getTableColumns(characters);

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
  ...characterBibleColumns,
  ...legacyLookColumns,
  // The voice IS the selected version row (#1788); all null without one.
  voiceId: characterVoiceVersions.voiceId,
  voiceDescription: characterVoiceVersions.description,
  voicePreviews: characterVoiceVersions.previews,
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

export function createCharactersMethods(db: Database) {
  const looks = createCharacterLooksMethods(db);

  /** The character rows and the joins they depend on, looks not yet resolved. */
  const selectRows = () =>
    db
      .select(characterColumns)
      .from(characters)
      .leftJoin(
        characterBibleVersions,
        eq(characterBibleVersions.id, characters.selectedBibleVersionId)
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
    rows: readonly Row[]
  ): Promise<CharacterWithSheet[]> => {
    if (rows.length === 0) return [];
    const all = await looks.listByCharacters(rows.map((row) => row.id));
    return rows.map((row) => {
      const {
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

  /** Resolved characters matching `where`. */
  const selectCharacters = async (
    where: SQL | undefined
  ): Promise<CharacterWithSheet[]> =>
    await resolveLooks(await selectRows().where(where));

  /** A write's row, re-read so it carries the resolved bible, looks and voice. */
  const reread = async (
    row: Pick<CharacterRow, 'id'> | undefined
  ): Promise<CharacterWithSheet> => {
    if (!row) throw new Error('SequenceCharacter not found');
    const [character] = await selectCharacters(eq(characters.id, row.id));
    if (!character) throw new Error(`SequenceCharacter ${row.id} not found`);
    return character;
  };

  /**
   * The one writer of a bible (#1600): the statements that append a version
   * row and point the character at it, for the caller's own `db.batch`. A
   * change to a field the sheets read revokes the in-flight sheet claim of
   * every look (#1113, #2015) in the same batch. Empty when nothing moved and
   * the row already has a version.
   */
  const bibleWrite = (
    existing: Character,
    patch: Partial<CharacterBible>,
    opts: { source: BibleVersionSource; createdBy: string | null }
  ) => {
    const before = pickCharacterBible(existing);
    const after = mergeBible(before, patch);
    const moved = characterBibleChanged(before, after);
    if (moved.length === 0 && existing.selectedBibleVersionId) {
      return { moved, statements: [] };
    }
    const versionId = generateId();
    return {
      moved,
      statements: [
        db.insert(characterBibleVersions).values({
          id: versionId,
          characterId: existing.id,
          ...after,
          source: opts.source,
          createdBy: opts.createdBy,
        }),
        db
          .update(characters)
          .set({ selectedBibleVersionId: versionId, updatedAt: new Date() })
          .where(eq(characters.id, existing.id)),
        ...(touchesSheet(moved)
          ? [demoteCharacterSheetClaims(db, eq(characters.id, existing.id))]
          : []),
      ],
    };
  };

  // Private update helper. Voice
  // fields are NOT writable here — a new value goes through `updateVoice`,
  // which appends the history row and moves the pointer (#1657).
  const update = async (
    id: string,
    data: CharacterUpdate
  ): Promise<Character> => {
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
      .where(eq(characters.id, id))
      .returning({ id: characters.id });

    if (!character) {
      throw new Error(`SequenceCharacter ${id} not found`);
    }

    return await reread(character);
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
  ): Promise<Character> => {
    const [existing] = await selectCharacters(eq(characters.id, id));
    if (!existing) throw new Error(`SequenceCharacter ${id} not found`);
    const versionId = generateId();
    const [, updatedRows] = await db.batch([
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
        .where(eq(characters.id, id))
        .returning({ id: characters.id }),
    ]);
    return await reread(updatedRows[0]);
  };

  /** The live shots whose scene tags this character, optionally in one look. */
  const shotsOf = async (
    sequenceId: string,
    characterId: string,
    wearing?: string
  ): Promise<Shot[]> => {
    const [character] = await selectCharacters(eq(characters.id, characterId));
    if (!character || character.sequenceId !== sequenceId) return [];
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

  return {
    getById: async (id: string): Promise<CharacterWithSheet | null> => {
      const result = await selectCharacters(eq(characters.id, id));
      return result[0] ?? null;
    },

    getByCharacterId: async (
      sequenceId: string,
      characterId: string
    ): Promise<CharacterWithSheet | null> => {
      const result = await selectCharacters(
        and(
          eq(characters.sequenceId, sequenceId),
          eq(characters.characterId, characterId)
        )
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
        await pageOf(
          selectRows().$dynamic(),
          and(
            eq(characters.sequenceId, sequenceId),
            isNull(characters.deletedAt)
          ),
          characters.id,
          page
        )
      );
    },

    /** Soft-deleted characters of the sequence, most recently deleted first. */
    listDeleted: async (sequenceId: string): Promise<CharacterWithSheet[]> =>
      await resolveLooks(
        await selectRows()
          .where(
            and(
              eq(characters.sequenceId, sequenceId),
              isNotNull(characters.deletedAt)
            )
          )
          .orderBy(desc(characters.deletedAt))
      ),

    /**
     * Every bible version of the sequence's characters, oldest first (#1600).
     * Staleness causes diff the version live when an artifact was made
     * against the live bible.
     */
    listBibleVersionsBySequence: async (sequenceId: string) =>
      await db
        .select(getTableColumns(characterBibleVersions))
        .from(characterBibleVersions)
        .innerJoin(
          characters,
          eq(characters.id, characterBibleVersions.characterId)
        )
        .where(eq(characters.sequenceId, sequenceId))
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
        .from(characters)
        .leftJoin(talent, eq(characters.talentId, talent.id))
        .leftJoin(
          characterBibleVersions,
          eq(characterBibleVersions.id, characters.selectedBibleVersionId)
        )
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
            eq(characters.sequenceId, sequenceId),
            isNull(characters.deletedAt)
          )
        );

      const resolved = await resolveLooks(results.map((row) => row.character));
      return resolved.map((character, index) => {
        const cast = results[index]?.talent;
        return { ...character, talent: cast?.id ? cast : null };
      });
    },

    getByIds: async (ids: string[]): Promise<CharacterWithSheet[]> => {
      if (ids.length === 0) return [];
      return await selectCharacters(inArray(characters.id, ids));
    },

    listWithSheets: async (
      sequenceId: string
    ): Promise<CharacterWithSheet[]> => {
      // A character counts once any of its looks has a finished sheet: a
      // scene may pick a look other than the default (#2015).
      const live = await selectCharacters(
        and(eq(characters.sequenceId, sequenceId), isNull(characters.deletedAt))
      );
      return live.filter(
        (character) =>
          character.sheetStatus === 'completed' ||
          character.looks.some((look) => look.sheetStatus === 'completed')
      );
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
      const [existing] = await selectCharacters(
        and(
          eq(characters.sequenceId, data.sequenceId),
          eq(characters.characterId, data.characterId)
        )
      );
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
        ...row
      } = data;
      // A field left out keeps its value, as the column upsert did.
      const bible = mergeBible(
        existing
          ? pickCharacterBible(existing)
          : { ...NEW_CHARACTER_BIBLE, name: data.name },
        bibleOf(data)
      );
      const moved = existing
        ? characterBibleChanged(pickCharacterBible(existing), bible)
        : [...CHARACTER_BIBLE_FIELDS];
      const appendVersion =
        !existing || !existing.selectedBibleVersionId || moved.length > 0;
      const talentMoved =
        !!existing &&
        data.talentId !== undefined &&
        data.talentId !== existing.talentId;
      const revokeClaim = !!existing && (touchesSheet(moved) || talentMoved);
      const id = existing?.id ?? data.id ?? generateId();
      const versionId = generateId();
      const lookVersionId = generateId();
      // An existing character with no look yet (an older worker's) gets its
      // default filled in first.
      const defaultLook = existing
        ? await requireLook(db, existing.lookId)
        : null;
      const pointer = appendVersion
        ? { selectedBibleVersionId: versionId }
        : {};
      const upsert = db
        .insert(characters)
        .values({ ...row, id, legacyName: bible.name, ...pointer })
        .onConflictDoUpdate({
          target: [characters.sequenceId, characters.characterId],
          set: {
            // Sheet OUTPUT is not re-written here (#1419). A re-analysis used
            // to blank `sheetImageUrl` while leaving the version rows intact,
            // so the character rendered sheet-less until it regenerated.
            talentId: data.talentId,
            ...pointer,
            // A re-analysis re-extracting a soft-deleted character revives it —
            // the script says the character exists again (#1108).
            deletedAt: null,
            updatedAt: new Date(),
          },
        });
      await db.batch([
        upsert,
        ...(appendVersion
          ? [
              db.insert(characterBibleVersions).values({
                id: versionId,
                characterId: id,
                ...bible,
                source: opts.source,
                createdBy: opts.createdBy,
              }),
            ]
          : []),
        ...(defaultLook
          ? [
              // `sheetStatus` is the default look's: both callers pass an
              // explicit lifecycle value ('generating' for re-analysis,
              // 'pending' for a manual add).
              ...(sheetStatus === undefined
                ? []
                : [
                    db
                      .update(characterLooks)
                      .set({ sheetStatus, updatedAt: new Date() })
                      .where(eq(characterLooks.id, defaultLook.id)),
                  ]),
              ...lookDefinitionWrite(
                db,
                defaultLook,
                { clothing },
                { source: lookSource(opts.source), createdBy: opts.createdBy }
              ).statements,
              ...(revokeClaim
                ? [demoteCharacterSheetClaims(db, eq(characters.id, id))]
                : []),
            ]
          : [
              // The default look reuses the character's id, as the backfill's
              // do, so a character has one whoever wrote it.
              db.insert(characterLooks).values({
                id,
                characterId: id,
                isDefault: true,
                sortOrder: 0,
                selectedLookVersionId: lookVersionId,
                sheetStatus: sheetStatus ?? 'pending',
              }),
              db.insert(characterLookVersions).values({
                id: lookVersionId,
                lookId: id,
                name: DEFAULT_LOOK_NAME,
                clothing: clothing ?? null,
                styling: null,
                source: lookSource(opts.source),
                createdBy: opts.createdBy,
              }),
            ]),
      ]);
      const character = await reread({ id });
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
        return await updateVoice(
          character.id,
          voicePatch,
          // A voice id only ever arrives as the cast talent's copy.
          voicePatch.voiceId ? 'library' : 'analysis',
          // Seeded by the cast-records step, not by a person.
          null
        );
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
    ): Promise<Character> => {
      const [existing] = await selectCharacters(eq(characters.id, id));
      if (!existing) throw new Error(`SequenceCharacter ${id} not found`);
      const next = markPreviewUnusable(
        existing.voicePreviews ?? [],
        generatedVoiceId,
        reason
      );
      // No previews without a selected version: `next` is null then.
      const versionId = existing.selectedVoiceVersionId;
      if (!next || !versionId) return existing;
      const [, updatedRows] = await db.batch([
        db
          .update(characterVoiceVersions)
          .set({ previews: next })
          .where(eq(characterVoiceVersions.id, versionId)),
        db
          .update(characters)
          .set({ updatedAt: new Date() })
          .where(eq(characters.id, id))
          .returning({ id: characters.id }),
      ]);
      return await reread(updatedRows[0]);
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
          current: sql<number>`(${characters.selectedVoiceVersionId} = ${characterVoiceVersions.id} and ${characters.deletedAt} is null)`,
        })
        .from(characterVoiceVersions)
        .innerJoin(
          characters,
          eq(characters.id, characterVoiceVersions.characterId)
        )
        .where(eq(characters.sequenceId, sequenceId));
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
    ): Promise<Character> => {
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
      return await reread(updated);
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

    // Bible versions and looks RESTRICT the parent delete (#1600, #2015, the
    // #612 rebuild trap), so they go first in the same batch.
    delete: async (id: string): Promise<boolean> => {
      const [, , , result] = await db.batch([
        db
          .delete(characterBibleVersions)
          .where(eq(characterBibleVersions.characterId, id)),
        ...deleteLooksOfCharacters(db, eq(characters.id, id)),
        db.delete(characters).where(eq(characters.id, id)),
      ]);
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const [, , , result] = await db.batch([
        db
          .delete(characterBibleVersions)
          .where(
            inArray(
              characterBibleVersions.characterId,
              db
                .select({ id: characters.id })
                .from(characters)
                .where(eq(characters.sequenceId, sequenceId))
            )
          ),
        ...deleteLooksOfCharacters(db, eq(characters.sequenceId, sequenceId)),
        db.delete(characters).where(eq(characters.sequenceId, sequenceId)),
      ]);
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
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
      const [existing] = await selectCharacters(eq(characters.id, characterId));
      if (!existing)
        throw new Error(`SequenceCharacter ${characterId} not found`);
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
      return updated ? await reread(updated) : null;
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
        and(eq(characters.sequenceId, sequenceId), isNull(characters.deletedAt))
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
     */
    updateBible: async (
      id: string,
      data: CharacterBibleUpdate,
      opts: {
        actorId: string | null;
        /** 'edit' for a person's form/API edit; 'recast' for a talent cast. */
        source: Extract<BibleVersionSource, 'edit' | 'recast'>;
      }
    ): Promise<Character> => {
      const [existing] = await selectCharacters(eq(characters.id, id));
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
      const defaultLook = await requireLook(db, existing.lookId);
      const { voiceDescription, standardClothing, ...bibleData } = data;
      // Appends a version and moves the pointer (#1600); an edit to a field
      // the sheet reads also revokes an in-flight sheet run's claim (#1113).
      const { statements } = bibleWrite(existing, bibleData, {
        source: opts.source,
        createdBy: opts.actorId,
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
      ]);
      // `voiceDescription` is the selected voice version's, so an edit to it
      // is a voice write and belongs in the voice history (#1657). Only when it
      // actually moved: the form posts every field, and a row per unrelated
      // bible edit would bury the real takes.
      if (
        voiceDescription !== undefined &&
        voiceDescription !== existing.voiceDescription
      ) {
        return await updateVoice(
          id,
          { voiceDescription },
          'user-edit',
          opts.actorId
        );
      }
      return await reread(existing);
    },

    /**
     * Soft-remove from the sequence (undoable): stamp `deletedAt` + a
     * `character.deleted` event in one batch. Scene continuity tags are NOT
     * touched (plan §1 — lossless undo); prompts that referenced the character
     * read stale by derivation because the bible reads above exclude the row.
     * Returns the timestamp for the toast Undo. No-ops (returns the existing
     * timestamp) when already deleted.
     */
    softDelete: async (
      id: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [existing] = await selectCharacters(eq(characters.id, id));
      if (!existing) {
        throw new Error(`SequenceCharacter ${id} not found`);
      }
      if (existing.deletedAt) return existing.deletedAt;
      const deletedAt = new Date();
      await db.batch([
        db
          .update(characters)
          .set({ deletedAt, updatedAt: deletedAt })
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

    /** Undo a soft delete (clears `deletedAt`), with a matching event. */
    restore: async (
      id: string,
      opts: { actorId: string | null }
    ): Promise<Character> => {
      const [existing] = await selectCharacters(eq(characters.id, id));
      if (!existing) {
        throw new Error(`SequenceCharacter ${id} not found`);
      }
      const now = new Date();
      const [restoredRows] = await db.batch([
        db
          .update(characters)
          .set({ deletedAt: null, updatedAt: now })
          .where(eq(characters.id, id))
          .returning({ id: characters.id }),
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
      return await reread(restoredRows[0]);
    },

    updateTalent: async (
      characterId: string,
      talentId: string | null
    ): Promise<Character> => {
      // The cast talent feeds every look's sheet: a recast revokes their
      // claims (#1113, #2015).
      const [[character]] = await db.batch([
        db
          .update(characters)
          .set({ talentId, updatedAt: new Date() })
          .where(eq(characters.id, characterId))
          .returning({ id: characters.id }),
        demoteCharacterSheetClaims(db, eq(characters.id, characterId)),
      ]);

      if (!character) {
        throw new Error(`Character ${characterId} not found`);
      }

      return await reread(character);
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
