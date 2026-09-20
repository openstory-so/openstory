/**
 * Scoped Characters Sub-module
 * Character CRUD, sheet generation, talent assignment, and shot-character matching.
 */

import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  sql,
} from 'drizzle-orm';
import type { Database } from '@/platform/server/db/client';
import { pageOf } from '@/platform/server/db/read-page';
import type { PageOptions } from '@/platform/server/db/read-page';
import type {
  CharacterWithSheet,
  Character,
  CharacterVoiceVersionSource,
  CharacterWithTalent,
  Shot,
  NewCharacter,
  SheetStatus,
} from '@/platform/server/db/schema';
import {
  characterSheetVariants,
  characterVoiceVersions,
  characters,
  shots,
  talent,
} from '@/platform/server/db/schema';
import { generateId } from '@/platform/id';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import { typedEntries } from '@/platform/typed-object';
import { matchCharacterToShotTags } from '@/shots/scene-matching';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
import type { CharacterSheetInputHash } from '@/shots/input-hash';
import { buildEventInsert } from '@/sequences/server/db/sequence-events';

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
 * The four columns that mirror the selected `character_voice_versions` row
 * (#1657). They move only through `updateVoice`, which appends the history
 * row and moves the pointer with them; `update` refuses them so a voice write
 * cannot land without saying where it came from.
 */
const VOICE_FIELDS = [
  'voiceId',
  'voiceDescription',
  'voicePreviews',
  'useVoice',
] as const;
type VoiceField = (typeof VOICE_FIELDS)[number];

type CharacterVoiceUpdate = Partial<Pick<NewCharacter, VoiceField>>;
/** Everything but the voice mirror — see {@link VOICE_FIELDS}. */
type CharacterUpdate = Partial<Omit<NewCharacter, VoiceField>>;

/**
 * The character's live sheet version (#1419 PR B).
 *
 * The explicit selection when there is one, else the row the #1419 backfill
 * keyed to the character's own id — the snapshot of the pre-versioning sheet
 * that used to live in the mirror columns. Both branches are a primary-key
 * lookup on `character_sheet_variants`.
 *
 * The pointer stays NULL on those legacy rows on purpose. It feeds the shot
 * thumbnail hash as `selectedSheetVersionId ?? sheetInputHash`
 * (`workflows/sheet-snapshots.ts`), so filling it would move the ingredient
 * for ~1,600 characters and read every shot referencing one as stale. It gets
 * set the first time anyone re-rolls or selects a version, through
 * `applyConvergent` / `select` — so the NULL drains as characters are touched
 * rather than being a permanent second class.
 */
const liveSheetVersionId = sql`COALESCE(${characters.selectedSheetVersionId}, ${characters.id})`;

/**
 * Character columns with the four sheet mirrors resolved from that live
 * version instead of read off the row (#1419). Same field names, so callers
 * are unchanged and PR C can drop the physical columns — at which point any
 * call site still reading them off a raw `Character` fails to compile, which
 * is how we find the ones that never came through here.
 *
 * `sheetStatus` and `sheetError` are NOT in this list. They are character-level
 * generation lifecycle, not version mirrors: `generating` is stamped at trigger
 * time and `failed` on workflow failure, both when no variant row exists to
 * carry them. #1067 kept `frames.imageStatus` / `imageError` for the same
 * reason.
 */
const charactersWithLiveSheet = {
  ...getTableColumns(characters),
  sheetImageUrl: characterSheetVariants.url,
  sheetImagePath: characterSheetVariants.storagePath,
  sheetGeneratedAt: characterSheetVariants.generatedAt,
  sheetInputHash: characterSheetVariants.inputHash,
};

export function createCharactersMethods(db: Database) {
  /** `select(charactersWithLiveSheet)` + the join it depends on. */
  const selectWithLiveSheet = () =>
    db
      .select(charactersWithLiveSheet)
      .from(characters)
      .leftJoin(
        characterSheetVariants,
        eq(characterSheetVariants.id, liveSheetVersionId)
      );

  /** Deselect whatever row the character currently points at. */
  const deselectVoiceVersions = (characterId: string) =>
    db
      .update(characterVoiceVersions)
      .set({ selectedAt: null })
      .where(
        and(
          eq(characterVoiceVersions.characterId, characterId),
          sql`${characterVoiceVersions.selectedAt} IS NOT NULL`
        )
      );

  // Private update helper used by updateSheetStatus and updateSheet. Voice
  // fields are NOT writable here — they go through `updateVoice`, which
  // appends the history row and moves the pointer (#1657).
  const update = async (
    id: string,
    data: CharacterUpdate
  ): Promise<Character> => {
    // Belt for the non-literal call site TypeScript's excess-property check
    // cannot see (a spread, a widened variable): a voice write with no source
    // would append no history and leave the pointer stale.
    for (const key of VOICE_FIELDS) {
      if (key in data) {
        throw new Error(`Write ${key} through updateVoice, not update`);
      }
    }
    const [character] = await db
      .update(characters)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(characters.id, id))
      .returning();

    if (!character) {
      throw new Error(`SequenceCharacter ${id} not found`);
    }

    return character;
  };

  /**
   * The only way a voice field moves (#1657): one `db.batch` that appends the
   * history row, selects it, writes the mirror columns and points the
   * character at it. `source` says WHY — a release and a library pick both
   * used to be inferred as 'generated'.
   */
  const updateVoice = async (
    id: string,
    data: CharacterVoiceUpdate,
    source: CharacterVoiceVersionSource
  ): Promise<Character> => {
    const [existing] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, id));
    if (!existing) throw new Error(`SequenceCharacter ${id} not found`);
    const versionId = generateId();
    const [, , updatedRows] = await db.batch([
      deselectVoiceVersions(id),
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
        selectedAt: new Date(),
      }),
      db
        .update(characters)
        .set({
          ...data,
          selectedVoiceVersionId: versionId,
          updatedAt: new Date(),
        })
        .where(eq(characters.id, id))
        .returning(),
    ]);
    const character = updatedRows[0];
    if (!character) throw new Error(`SequenceCharacter ${id} not found`);
    return character;
  };

  return {
    getById: async (id: string): Promise<CharacterWithSheet | null> => {
      const result = await selectWithLiveSheet().where(eq(characters.id, id));
      return result[0] ?? null;
    },

    getByCharacterId: async (
      sequenceId: string,
      characterId: string
    ): Promise<CharacterWithSheet | null> => {
      const result = await selectWithLiveSheet().where(
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
      return await pageOf(
        selectWithLiveSheet().$dynamic(),
        and(
          eq(characters.sequenceId, sequenceId),
          isNull(characters.deletedAt)
        ),
        characters.id,
        page
      );
    },

    listWithTalent: async (
      sequenceId: string
    ): Promise<CharacterWithTalent[]> => {
      const results = await db
        .select({
          character: charactersWithLiveSheet,
          talent: {
            id: talent.id,
            name: talent.name,
            imageUrl: talent.imageUrl,
          },
        })
        .from(characters)
        .leftJoin(talent, eq(characters.talentId, talent.id))
        .leftJoin(
          characterSheetVariants,
          eq(characterSheetVariants.id, liveSheetVersionId)
        )
        .where(
          and(
            eq(characters.sequenceId, sequenceId),
            isNull(characters.deletedAt)
          )
        );

      return results.map((row) => ({
        ...row.character,
        talent: row.talent?.id ? row.talent : null,
      }));
    },

    getByIds: async (ids: string[]): Promise<CharacterWithSheet[]> => {
      if (ids.length === 0) return [];
      return await selectWithLiveSheet().where(inArray(characters.id, ids));
    },

    listWithSheets: async (
      sequenceId: string
    ): Promise<CharacterWithSheet[]> => {
      return await selectWithLiveSheet().where(
        and(
          eq(characters.sequenceId, sequenceId),
          eq(characters.sheetStatus, 'completed'),
          isNull(characters.deletedAt)
        )
      );
    },

    create: async (data: NewCharacter): Promise<Character> => {
      const [character] = await db
        .insert(characters)
        .values(data)
        .onConflictDoUpdate({
          target: [characters.sequenceId, characters.characterId],
          set: {
            name: data.name,
            age: data.age,
            gender: data.gender,
            ethnicity: data.ethnicity,
            physicalDescription: data.physicalDescription,
            standardClothing: data.standardClothing,
            distinguishingFeatures: data.distinguishingFeatures,
            personality: data.personality,
            movement: data.movement,
            voiceOnly: data.voiceOnly,
            isPerson: data.isPerson,
            // A voice already on the row wins (#1553): re-writing it would
            // orphan an ElevenLabs slot. A row without one takes the talent
            // copy the insert carries.
            voiceId: sql`coalesce(${characters.voiceId}, excluded.voice_id)`,
            voiceDescription: sql`coalesce(${characters.voiceDescription}, excluded.voice_description)`,
            consistencyTag: data.consistencyTag,
            // Sheet OUTPUT is not re-written here (#1419). A re-analysis used
            // to blank `sheetImageUrl` while leaving the version rows intact,
            // so the character rendered sheet-less until it regenerated.
            // `sheetStatus` stays: both callers pass an explicit lifecycle
            // value ('generating' for re-analysis, 'pending' for a manual add).
            sheetStatus: data.sheetStatus,
            talentId: data.talentId,
            // A re-analysis re-extracting a soft-deleted character revives it —
            // the script says the character exists again (#1108).
            deletedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!character) {
        throw new Error(
          `Failed to create Character for sequence ${data.sequenceId} (characterId ${data.characterId})`
        );
      }
      // The ORIGINAL history row (#1657): the voice the cast arrived with.
      // Without it history starts at the first edit, so the analysed /
      // talent-copied voice can never be selected back. Guarded on the
      // pointer, so the References-stage re-upsert of the same row does not
      // append a second one, and the `coalesce` above keeps an existing
      // voice — a row whose voice did NOT come from this insert is labelled
      // 'analysis' rather than claimed as the talent's.
      if (
        !character.selectedVoiceVersionId &&
        (character.voiceId ?? character.voiceDescription)
      ) {
        // An empty patch: the version copies the row's voice as it stands.
        return await updateVoice(
          character.id,
          {},
          character.voiceId && character.voiceId === data.voiceId
            ? 'library'
            : 'analysis'
        );
      }
      return character;
    },

    update,
    updateVoice,

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
        throw new Error(
          `Voice version ${versionId} not found for character ${characterId}`
        );
      // The id on a released row no longer exists at ElevenLabs, so selecting
      // it would put a dead voice on the row and 404 at TTS (#1657).
      if (version.releasedAt) {
        throw new Error(
          'This voice was deleted when it stopped being used; design or pick a new one.'
        );
      }
      const [, , updatedRows] = await db.batch([
        deselectVoiceVersions(characterId),
        db
          .update(characterVoiceVersions)
          .set({ selectedAt: new Date() })
          .where(eq(characterVoiceVersions.id, version.id)),
        db
          .update(characters)
          .set({
            voiceId: version.voiceId,
            voiceDescription: version.description,
            voicePreviews: version.previews,
            useVoice: version.enabled,
            selectedVoiceVersionId: version.id,
            updatedAt: new Date(),
          })
          .where(eq(characters.id, characterId))
          .returning(),
      ]);
      const updated = updatedRows[0];
      if (!updated)
        throw new Error(`SequenceCharacter ${characterId} not found`);
      return updated;
    },

    /**
     * Rows (any team — the id is the ElevenLabs account's) still pointing at
     * a voice, across characters AND talent, soft-deleted rows included:
     * soft-delete stamps `deletedAt` and THEN releases (provider first, row
     * second), so a deleted row still holding an id is a release that
     * failed, and the voice it names is still on the account. `get` prefix
     * on purpose: it is a read, so the workflow surface strips it.
     */
    getVoiceReferenceCount: async (voiceId: string): Promise<number> => {
      const [chars] = await db
        .select({ n: count() })
        .from(characters)
        .where(eq(characters.voiceId, voiceId));
      const [tal] = await db
        .select({ n: count() })
        .from(talent)
        .where(eq(talent.voiceId, voiceId));
      return (chars?.n ?? 0) + (tal?.n ?? 0);
    },

    delete: async (id: string): Promise<boolean> => {
      const result = await db.delete(characters).where(eq(characters.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(characters)
        .where(eq(characters.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    updateSheetStatus: async (
      id: string,
      status: SheetStatus,
      error?: string
    ): Promise<Character> => {
      return await update(id, {
        sheetStatus: status,
        sheetError: error ?? null,
      });
    },

    /**
     * Convergent sheet write: append a version and select it. `opts.model`
     * labels the history row; defaults to `'unknown'` when the caller has
     * no model (legacy tests).
     */
    updateSheet: async (
      id: string,
      imageUrl: string,
      imagePath: string,
      inputHash: CharacterSheetInputHash | null = null,
      opts?: { model?: string; workflowRunId?: string | null }
    ): Promise<Character> => {
      const { character } = await createCharacterSheetVariantsMethods(
        db
      ).applyConvergent({
        characterId: id,
        url: imageUrl,
        storagePath: imagePath,
        inputHash,
        model: opts?.model ?? 'unknown',
        workflowRunId: opts?.workflowRunId,
      });
      return character;
    },

    getNeedingSheets: async (
      sequenceId: string
    ): Promise<CharacterWithSheet[]> => {
      return await selectWithLiveSheet().where(
        and(
          eq(characters.sequenceId, sequenceId),
          inArray(characters.sheetStatus, ['pending', 'failed']),
          isNull(characters.deletedAt)
        )
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
      opts: { actorId: string | null }
    ): Promise<Character> => {
      const [existing] = await db
        .select()
        .from(characters)
        .where(eq(characters.id, id));
      if (!existing) {
        throw new Error(`SequenceCharacter ${id} not found`);
      }
      const prev: Record<string, string | boolean | null> = {};
      for (const [key, value] of typedEntries(data)) {
        if (value === undefined) continue;
        prev[key] = existing[key] ?? null;
      }
      const [updatedRows] = await db.batch([
        db
          .update(characters)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(characters.id, id))
          .returning(),
        buildEventInsert(db, {
          sequenceId: existing.sequenceId,
          actorId: opts.actorId,
          kind: 'character.updated',
          targetType: 'character',
          targetId: id,
          summary: `Edited character ${data.name ?? existing.name}`,
          data: { prevState: prev },
        }),
      ]);
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`SequenceCharacter ${id} disappeared during update`);
      }
      // `voiceDescription` is a bible field AND part of the voice mirror, so
      // an edit to it is a voice write and belongs in the history (#1657).
      // Only when it actually moved: the form posts every field, and a row
      // per unrelated bible edit would bury the real takes.
      if (
        data.voiceDescription !== undefined &&
        data.voiceDescription !== existing.voiceDescription
      ) {
        return await updateVoice(
          id,
          { voiceDescription: data.voiceDescription },
          'user-edit'
        );
      }
      return updated;
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
      const [existing] = await db
        .select()
        .from(characters)
        .where(eq(characters.id, id));
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
      const [existing] = await db
        .select()
        .from(characters)
        .where(eq(characters.id, id));
      if (!existing) {
        throw new Error(`SequenceCharacter ${id} not found`);
      }
      const now = new Date();
      const [restoredRows] = await db.batch([
        db
          .update(characters)
          .set({ deletedAt: null, updatedAt: now })
          .where(eq(characters.id, id))
          .returning(),
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
      const restored = restoredRows[0];
      if (!restored) {
        throw new Error(`SequenceCharacter ${id} disappeared during restore`);
      }
      return restored;
    },

    updateTalent: async (
      characterId: string,
      talentId: string | null
    ): Promise<Character> => {
      const [character] = await db
        .update(characters)
        .set({ talentId, updatedAt: new Date() })
        .where(eq(characters.id, characterId))
        .returning();

      if (!character) {
        throw new Error(`Character ${characterId} not found`);
      }

      return character;
    },

    getShotsForCharacter: async (
      sequenceId: string,
      characterId: string
    ): Promise<Shot[]> => {
      // Get the character to extract matching patterns
      const charResult = await db
        .select()
        .from(characters)
        .where(eq(characters.id, characterId));
      const character = charResult[0] ?? null;
      if (!character || character.sequenceId !== sequenceId) {
        return [];
      }

      const [allShots, sceneContext] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(
            and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
          ) as Promise<Shot[]>,
        loadSceneContextBySequenceFromDb(db, sequenceId),
      ]);

      // Filter shots that contain this character
      return allShots.filter((shot) => {
        const scene = resolveSceneForShot(shot, sceneContext).scene;
        const characterTags = scene?.continuity?.characterTags ?? [];
        return matchCharacterToShotTags(character, characterTags);
      });
    },

    getShotIdsForCharacter: async (
      sequenceId: string,
      characterId: string
    ): Promise<string[]> => {
      // Get the character to extract matching patterns
      const charResult = await db
        .select()
        .from(characters)
        .where(eq(characters.id, characterId));
      const character = charResult[0] ?? null;
      if (!character || character.sequenceId !== sequenceId) {
        return [];
      }

      const [allShots, sceneContext] = await Promise.all([
        db
          .select()
          .from(shots)
          .where(
            and(eq(shots.sequenceId, sequenceId), isNull(shots.deletedAt))
          ) as Promise<Shot[]>,
        loadSceneContextBySequenceFromDb(db, sequenceId),
      ]);

      // Filter shots that contain this character and return IDs
      return allShots
        .filter((shot) => {
          const scene = resolveSceneForShot(shot, sceneContext).scene;
          const characterTags = scene?.continuity?.characterTags ?? [];
          return matchCharacterToShotTags(character, characterTags);
        })
        .map((f) => f.id);
    },
  };
}
