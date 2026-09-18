/**
 * Scoped Scene Dialogue Sub-module (#1657).
 *
 * Two append-only tables, one selected row each:
 *
 *   `scene_dialogue_versions` — the authored lines, each naming its shot.
 *     The shot-list pass seeds a `prompt` row; a user edit appends
 *     `user-edit`. This is what References records and what render and
 *     staleness read.
 *   `scene_dialogue_takes` — the recordings. One ElevenLabs Text to Dialogue
 *     call per scene, with the per-turn segments each shot's clip is sliced
 *     at. `shots.audioClips` holds the slices (working set); the take is
 *     their provenance and the thing a user picks between.
 *
 * Every selection change is one `db.batch` — D1 has no interactive
 * transactions, and the partial unique index on `selectedAt` would reject a
 * clear-then-set done as two round trips that raced.
 */

import type { Database } from '@/platform/server/db/client';
import {
  sceneDialogueTakes,
  sceneDialogueVersions,
  scenes,
} from '@/platform/server/db/schema';
import type {
  DbSceneId,
  DialogueTakeSegment,
  MotionAudioClip,
  SceneDialogueLine,
  SceneDialogueSource,
  SceneDialogueTake,
  SceneDialogueVersion,
} from '@/platform/server/db/schema';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

export type AppendSceneDialogueTakeInput = {
  sceneId: DbSceneId;
  dialogueVersionId: string;
  inputHash: string;
  url: string;
  durationSeconds: number;
  segments: DialogueTakeSegment[];
  /** Per-shot slices, keyed by shot id — what selecting this take restores. */
  clips: Record<string, MotionAudioClip[]>;
  characterCount: number;
  workflowRunId?: string | null;
};

/** Same lines, same order, same bindings — nothing to append. */
function sameLines(
  a: readonly SceneDialogueLine[],
  b: readonly SceneDialogueLine[]
): boolean {
  return (
    a.length === b.length &&
    a.every((line, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        line.character === other.character &&
        line.line === other.line &&
        line.tone === other.tone &&
        line.shotId === other.shotId &&
        (line.voiceToken ?? null) === (other.voiceToken ?? null)
      );
    })
  );
}

export function createSceneDialogueMethods(db: Database) {
  const clearSelectedVersion = (sceneId: DbSceneId) =>
    db
      .update(sceneDialogueVersions)
      .set({ selectedAt: null })
      .where(
        and(
          eq(sceneDialogueVersions.sceneId, sceneId),
          sql`${sceneDialogueVersions.selectedAt} IS NOT NULL`
        )
      );

  const clearSelectedTake = (sceneId: DbSceneId) =>
    db
      .update(sceneDialogueTakes)
      .set({ selectedAt: null })
      .where(
        and(
          eq(sceneDialogueTakes.sceneId, sceneId),
          sql`${sceneDialogueTakes.selectedAt} IS NOT NULL`
        )
      );

  const getSelected = async (
    sceneId: DbSceneId
  ): Promise<SceneDialogueVersion | null> => {
    const [row] = await db
      .select()
      .from(sceneDialogueVersions)
      .where(
        and(
          eq(sceneDialogueVersions.sceneId, sceneId),
          sql`${sceneDialogueVersions.selectedAt} IS NOT NULL`
        )
      )
      .limit(1);
    return row ?? null;
  };

  return {
    getSelected,

    /** Selected authored lines for every scene of a sequence that has a row. */
    getSelectedBySequence: async (
      sequenceId: string
    ): Promise<SceneDialogueVersion[]> => {
      const rows = await db
        .select({ version: sceneDialogueVersions })
        .from(sceneDialogueVersions)
        .innerJoin(scenes, eq(scenes.id, sceneDialogueVersions.sceneId))
        .where(
          and(
            eq(scenes.sequenceId, sequenceId),
            sql`${sceneDialogueVersions.selectedAt} IS NOT NULL`
          )
        )
        .orderBy(scenes.orderIndex);
      return rows.map((row) => row.version);
    },

    listVersions: async (sceneId: DbSceneId): Promise<SceneDialogueVersion[]> =>
      await db
        .select()
        .from(sceneDialogueVersions)
        .where(eq(sceneDialogueVersions.sceneId, sceneId))
        .orderBy(
          desc(sceneDialogueVersions.createdAt),
          desc(sceneDialogueVersions.id)
        ),

    /**
     * Append the lines as a new selected version. Returns the selected row
     * UNCHANGED when it already says exactly this — a re-analysis, a replayed
     * workflow step and a Save with no edit all land here, and each would
     * otherwise mint a history row that says nothing.
     */
    write: async (
      sceneId: DbSceneId,
      lines: SceneDialogueLine[],
      source: SceneDialogueSource,
      opts?: { createdBy?: string | null }
    ): Promise<SceneDialogueVersion> => {
      const current = await getSelected(sceneId);
      if (current && sameLines(current.lines, lines)) return current;
      // Clear first: the statements apply in order inside one transaction, so
      // inserting a selected row before the clear would trip the partial
      // unique index.
      const [, inserted] = await db.batch([
        clearSelectedVersion(sceneId),
        db
          .insert(sceneDialogueVersions)
          .values({
            sceneId,
            lines,
            source,
            createdBy: opts?.createdBy ?? null,
            selectedAt: new Date(),
          })
          .returning(),
      ]);
      const [row] = inserted;
      if (!row) throw new Error('Failed to insert scene dialogue version');
      return row;
    },

    selectVersion: async (
      sceneId: DbSceneId,
      versionId: string
    ): Promise<SceneDialogueVersion> => {
      const [version] = await db
        .select()
        .from(sceneDialogueVersions)
        .where(
          and(
            eq(sceneDialogueVersions.id, versionId),
            eq(sceneDialogueVersions.sceneId, sceneId)
          )
        )
        .limit(1);
      if (!version) {
        throw new Error(
          `Scene dialogue version ${versionId} not found for scene ${sceneId}`
        );
      }
      const [, selected] = await db.batch([
        clearSelectedVersion(sceneId),
        db
          .update(sceneDialogueVersions)
          .set({ selectedAt: new Date() })
          .where(eq(sceneDialogueVersions.id, version.id))
          .returning(),
      ]);
      const [row] = selected;
      if (!row)
        throw new Error(`Failed to select dialogue version ${versionId}`);
      return row;
    },

    /** Record a take and make it the scene's selected one. */
    appendTake: async (
      input: AppendSceneDialogueTakeInput
    ): Promise<SceneDialogueTake> => {
      const [, inserted] = await db.batch([
        clearSelectedTake(input.sceneId),
        db
          .insert(sceneDialogueTakes)
          .values({
            sceneId: input.sceneId,
            dialogueVersionId: input.dialogueVersionId,
            inputHash: input.inputHash,
            url: input.url,
            durationSeconds: input.durationSeconds,
            segments: input.segments,
            clips: input.clips,
            characterCount: input.characterCount,
            workflowRunId: input.workflowRunId ?? null,
            selectedAt: new Date(),
          })
          .returning(),
      ]);
      const [row] = inserted;
      if (!row) throw new Error('Failed to insert scene dialogue take');
      return row;
    },

    listTakes: async (sceneId: DbSceneId): Promise<SceneDialogueTake[]> =>
      await db
        .select()
        .from(sceneDialogueTakes)
        .where(
          and(
            eq(sceneDialogueTakes.sceneId, sceneId),
            isNull(sceneDialogueTakes.discardedAt)
          )
        )
        .orderBy(
          desc(sceneDialogueTakes.createdAt),
          desc(sceneDialogueTakes.id)
        ),

    getTakeById: async (takeId: string): Promise<SceneDialogueTake | null> => {
      const [row] = await db
        .select()
        .from(sceneDialogueTakes)
        .where(eq(sceneDialogueTakes.id, takeId))
        .limit(1);
      return row ?? null;
    },

    getSelectedTake: async (
      sceneId: DbSceneId
    ): Promise<SceneDialogueTake | null> => {
      const [row] = await db
        .select()
        .from(sceneDialogueTakes)
        .where(
          and(
            eq(sceneDialogueTakes.sceneId, sceneId),
            sql`${sceneDialogueTakes.selectedAt} IS NOT NULL`
          )
        )
        .limit(1);
      return row ?? null;
    },

    getSelectedTakesBySequence: async (
      sequenceId: string
    ): Promise<SceneDialogueTake[]> => {
      const rows = await db
        .select({ take: sceneDialogueTakes })
        .from(sceneDialogueTakes)
        .innerJoin(scenes, eq(scenes.id, sceneDialogueTakes.sceneId))
        .where(
          and(
            eq(scenes.sequenceId, sequenceId),
            sql`${sceneDialogueTakes.selectedAt} IS NOT NULL`
          )
        )
        .orderBy(scenes.orderIndex);
      return rows.map((row) => row.take);
    },

    selectTake: async (
      sceneId: DbSceneId,
      takeId: string
    ): Promise<SceneDialogueTake> => {
      const [take] = await db
        .select()
        .from(sceneDialogueTakes)
        .where(
          and(
            eq(sceneDialogueTakes.id, takeId),
            eq(sceneDialogueTakes.sceneId, sceneId)
          )
        )
        .limit(1);
      if (!take) {
        throw new Error(
          `Scene dialogue take ${takeId} not found for scene ${sceneId}`
        );
      }
      if (take.discardedAt) {
        throw new Error(`Scene dialogue take ${takeId} was discarded`);
      }
      const [, selected] = await db.batch([
        clearSelectedTake(sceneId),
        db
          .update(sceneDialogueTakes)
          .set({ selectedAt: new Date() })
          .where(eq(sceneDialogueTakes.id, take.id))
          .returning(),
      ]);
      const [row] = selected;
      if (!row) throw new Error(`Failed to select dialogue take ${takeId}`);
      return row;
    },

    /** Soft-discard. A discarded take can never stay selected. */
    discardTake: async (sceneId: DbSceneId, takeId: string): Promise<void> => {
      await db
        .update(sceneDialogueTakes)
        .set({ discardedAt: new Date(), selectedAt: null })
        .where(
          and(
            eq(sceneDialogueTakes.id, takeId),
            eq(sceneDialogueTakes.sceneId, sceneId)
          )
        );
    },
  };
}
