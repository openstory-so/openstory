/**
 * Scoped Characters Sub-module
 * Character CRUD, sheet generation, talent assignment, and shot-character matching.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import type {
  Character,
  CharacterWithTalent,
  Shot,
  NewCharacter,
  SheetStatus,
} from '@/lib/db/schema';
import { characters, shots, talent } from '@/lib/db/schema';
import {
  loadSceneContextBySequenceFromDb,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { typedEntries } from '@/lib/utils/typed-object';
import { matchCharacterToShotTags } from '@/lib/workflows/scene-matching';
import { createCharacterSheetVariantsMethods } from './character-sheet-variants';
import { buildEventInsert } from './sequence-events';

/**
 * The user-editable character bible fields (#1108 Phase 2). Everything else on
 * the row (casting, sheet output, first-mention provenance) is owned by
 * dedicated paths. Editing any of these re-stales the character sheet and the
 * prompts that project them — purely by hash derivation.
 */
export type CharacterBibleUpdate = Partial<
  Pick<
    Character,
    | 'name'
    | 'age'
    | 'gender'
    | 'ethnicity'
    | 'physicalDescription'
    | 'standardClothing'
    | 'distinguishingFeatures'
    | 'consistencyTag'
  >
>;

export function createCharactersMethods(db: Database) {
  // Private update helper used by updateSheetStatus and updateSheet
  const update = async (
    id: string,
    data: Partial<NewCharacter>
  ): Promise<Character> => {
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

  return {
    getById: async (id: string): Promise<Character | null> => {
      const result = await db
        .select()
        .from(characters)
        .where(eq(characters.id, id));
      return result[0] ?? null;
    },

    getByCharacterId: async (
      sequenceId: string,
      characterId: string
    ): Promise<Character | null> => {
      const result = await db
        .select()
        .from(characters)
        .where(
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
    list: async (sequenceId: string): Promise<Character[]> => {
      return await db
        .select()
        .from(characters)
        .where(
          and(
            eq(characters.sequenceId, sequenceId),
            isNull(characters.deletedAt)
          )
        );
    },

    listWithTalent: async (
      sequenceId: string
    ): Promise<CharacterWithTalent[]> => {
      const results = await db
        .select({
          character: characters,
          talent: {
            id: talent.id,
            name: talent.name,
            imageUrl: talent.imageUrl,
          },
        })
        .from(characters)
        .leftJoin(talent, eq(characters.talentId, talent.id))
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

    getByIds: async (ids: string[]): Promise<Character[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(characters)
        .where(inArray(characters.id, ids));
    },

    listWithSheets: async (sequenceId: string): Promise<Character[]> => {
      return await db
        .select()
        .from(characters)
        .where(
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
            consistencyTag: data.consistencyTag,
            sheetImageUrl: data.sheetImageUrl,
            sheetImagePath: data.sheetImagePath,
            sheetStatus: data.sheetStatus,
            sheetGeneratedAt: data.sheetGeneratedAt,
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
      return character;
    },

    createBulk: async (data: NewCharacter[]): Promise<Character[]> => {
      if (data.length === 0) return [];
      const BATCH_SIZE = 4;
      const results: Character[] = [];

      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(characters)
          .values(batch)
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    update,

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
        ...(status === 'completed' && { sheetGeneratedAt: new Date() }),
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
      inputHash: string | null = null,
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

    getNeedingSheets: async (sequenceId: string): Promise<Character[]> => {
      return await db
        .select()
        .from(characters)
        .where(
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
      const prev: Record<string, string | null> = {};
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

    isStale: async (
      characterId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: characters.sheetInputHash })
        .from(characters)
        .where(eq(characters.id, characterId));
      const row = result[0];
      if (!row) {
        throw new Error(`Character ${characterId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
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
