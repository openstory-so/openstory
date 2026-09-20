/**
 * Scoped Shot Dialogue Sub-module (#1657).
 *
 * Three append-only tables:
 *
 *   `shot_dialogue_versions` — the authored lines of one shot, one selected
 *     row per shot. The shot-list pass seeds a `prompt` row; a user edit
 *     appends `user-edit`. This is what References records and what render
 *     and staleness read.
 *   `dialogue_recordings` — one row per ElevenLabs Text to Dialogue call, the
 *     whole file. No selected flag: a recording is never "the" recording of
 *     anything, it is what sections point into.
 *   `shot_dialogue_sections` — a shot's time range of a recording, one
 *     selected row per shot. A recording inserts a section for every shot it
 *     spoke and selects only the shots that adopt it, so a shot that was only
 *     context keeps the reading it had. `shots.audioClips` holds the cut file
 *     of the selected section (working set).
 *
 * Every selection change is one `db.batch` — D1 has no interactive
 * transactions, and the partial unique index on `selectedAt` would reject a
 * clear-then-set done as two round trips that raced.
 */

import type { Database } from '@/platform/server/db/client';
import {
  dialogueRecordings,
  shotDialogueSections,
  shotDialogueVersions,
  shots,
} from '@/platform/server/db/schema';
import type {
  DialogueRecording,
  MotionAudioClip,
  DialogueRecordingTurn,
  ShotDialogueLine,
  ShotDialogueSection,
  ShotDialogueSource,
  ShotDialogueVersion,
} from '@/platform/server/db/schema';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

export type AppendDialogueRecordingInput = {
  /** Generated inside the workflow step, so a replay lands on the same rows. */
  id: string;
  sequenceId: string;
  storageKey: string;
  url: string;
  durationSeconds: number;
  turns: DialogueRecordingTurn[];
  inputHash: string;
  characterCount: number;
  /** Null for a recording no workflow made. */
  workflowRunId: string | null;
  /** One per shot the call spoke. */
  sections: Array<{
    id: string;
    shotId: string;
    fromSeconds: number;
    toSeconds: number;
    sourceKey: string;
    /** Delivered wording; null when the authored lines were spoken as written. */
    spokenLines: { index: number; text: string }[] | null;
    /** Null when the lines were derived from the script (no version row). */
    dialogueVersionId: string | null;
    /** True for a shot that adopts this reading; false = spoken as context. */
    selected: boolean;
  }>;
};

/** Same lines, same order, same bindings — nothing to append. */
function sameLines(
  a: readonly ShotDialogueLine[],
  b: readonly ShotDialogueLine[]
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
        (line.voiceToken ?? null) === (other.voiceToken ?? null)
      );
    })
  );
}

export function createShotDialogueMethods(db: Database) {
  const clearSelectedVersion = (shotId: string) =>
    db
      .update(shotDialogueVersions)
      .set({ selectedAt: null })
      .where(
        and(
          eq(shotDialogueVersions.shotId, shotId),
          isNotNull(shotDialogueVersions.selectedAt)
        )
      );

  const clearSelectedSection = (shotId: string) =>
    db
      .update(shotDialogueSections)
      .set({ selectedAt: null })
      .where(
        and(
          eq(shotDialogueSections.shotId, shotId),
          isNotNull(shotDialogueSections.selectedAt)
        )
      );

  const getSelected = async (
    shotId: string
  ): Promise<ShotDialogueVersion | null> => {
    const [row] = await db
      .select()
      .from(shotDialogueVersions)
      .where(
        and(
          eq(shotDialogueVersions.shotId, shotId),
          isNotNull(shotDialogueVersions.selectedAt)
        )
      )
      .limit(1);
    return row ?? null;
  };

  return {
    getSelected,

    /** Selected authored lines for every live shot of a sequence that has a row. */
    getSelectedBySequence: async (
      sequenceId: string
    ): Promise<ShotDialogueVersion[]> => {
      const rows = await db
        .select({ version: shotDialogueVersions })
        .from(shotDialogueVersions)
        .innerJoin(shots, eq(shots.id, shotDialogueVersions.shotId))
        .where(
          and(
            eq(shots.sequenceId, sequenceId),
            isNull(shots.deletedAt),
            isNotNull(shotDialogueVersions.selectedAt)
          )
        );
      return rows.map((row) => row.version);
    },

    /**
     * Append the lines as a new selected version. Returns the selected row
     * UNCHANGED when it already says exactly this — a re-analysis, a replayed
     * workflow step and a Save with no edit all land here, and each would
     * otherwise mint a history row that says nothing. Null when there is
     * nothing to say and nothing was said before: a silent shot gets no row,
     * but a shot that LOST its lines gets an empty one, or the old row would
     * keep speaking.
     */
    write: async (
      shotId: string,
      lines: ShotDialogueLine[],
      source: ShotDialogueSource,
      opts?: { createdBy?: string | null }
    ): Promise<ShotDialogueVersion | null> => {
      const current = await getSelected(shotId);
      if (current && sameLines(current.lines, lines)) return current;
      if (!current && lines.length === 0) return null;
      // Clear first: the statements apply in order inside one transaction, so
      // inserting a selected row before the clear would trip the partial
      // unique index.
      const [, inserted] = await db.batch([
        clearSelectedVersion(shotId),
        db
          .insert(shotDialogueVersions)
          .values({
            shotId,
            lines,
            source,
            createdBy: opts?.createdBy ?? null,
            selectedAt: new Date(),
          })
          .returning(),
      ]);
      const [row] = inserted;
      if (!row) throw new Error('Failed to insert shot dialogue version');
      return row;
    },

    /**
     * Record one call: the recording, plus a section for every shot it spoke.
     * Adopting shots (`selected: true`) have their selection moved onto the
     * new section; context shots get an unselected row and keep what they had.
     *
     * Idempotent under replay: the ids come from the caller, and a recording
     * that already exists means this batch already committed whole — so the
     * replay returns before the clears, which would otherwise unselect the
     * very sections the first pass selected (or a reading picked since).
     * One statement per section keeps each under D1's 100-bound-parameter cap.
     */
    appendRecording: async (
      input: AppendDialogueRecordingInput
    ): Promise<void> => {
      const [existing] = await db
        .select({ id: dialogueRecordings.id })
        .from(dialogueRecordings)
        .where(eq(dialogueRecordings.id, input.id))
        .limit(1);
      if (existing) return;

      // The recording is a soft pointer, so no CHECK can say this.
      const outside = input.sections.find(
        (section) => section.toSeconds > input.durationSeconds
      );
      if (outside) {
        throw new Error(
          `Section ${outside.id} ends at ${outside.toSeconds}s, past its ${input.durationSeconds}s recording`
        );
      }

      const now = new Date();
      await db.batch([
        db
          .insert(dialogueRecordings)
          .values({
            id: input.id,
            sequenceId: input.sequenceId,
            storageKey: input.storageKey,
            url: input.url,
            durationSeconds: input.durationSeconds,
            turns: input.turns,
            inputHash: input.inputHash,
            characterCount: input.characterCount,
            workflowRunId: input.workflowRunId,
          })
          .onConflictDoNothing(),
        // Clear first, then insert — the partial unique index rejects the
        // other order.
        ...input.sections
          .filter((section) => section.selected)
          .map((section) => clearSelectedSection(section.shotId)),
        ...input.sections.map((section) =>
          db
            .insert(shotDialogueSections)
            .values({
              id: section.id,
              shotId: section.shotId,
              recordingId: input.id,
              fromSeconds: section.fromSeconds,
              toSeconds: section.toSeconds,
              sourceKey: section.sourceKey,
              spokenLines: section.spokenLines,
              dialogueVersionId: section.dialogueVersionId,
              source: section.selected ? 'recorded' : 'context',
              selectedAt: section.selected ? now : null,
              workflowRunId: input.workflowRunId,
            })
            .onConflictDoNothing()
        ),
      ]);
    },

    /** A shot's readings, newest first, each with the file it points into. */
    listSections: async (
      shotId: string
    ): Promise<Array<ShotDialogueSection & { recordingUrl: string }>> => {
      const rows = await db
        .select({
          section: shotDialogueSections,
          recordingUrl: dialogueRecordings.url,
        })
        .from(shotDialogueSections)
        .innerJoin(
          dialogueRecordings,
          eq(dialogueRecordings.id, shotDialogueSections.recordingId)
        )
        .where(
          and(
            eq(shotDialogueSections.shotId, shotId),
            isNull(shotDialogueSections.discardedAt)
          )
        )
        .orderBy(
          desc(shotDialogueSections.createdAt),
          desc(shotDialogueSections.id)
        );
      return rows.map((row) => ({
        ...row.section,
        recordingUrl: row.recordingUrl,
      }));
    },

    getSectionById: async (
      sectionId: string
    ): Promise<
      (ShotDialogueSection & { recording: DialogueRecording }) | null
    > => {
      const [row] = await db
        .select({
          section: shotDialogueSections,
          recording: dialogueRecordings,
        })
        .from(shotDialogueSections)
        .innerJoin(
          dialogueRecordings,
          eq(dialogueRecordings.id, shotDialogueSections.recordingId)
        )
        .where(eq(shotDialogueSections.id, sectionId))
        .limit(1);
      return row ? { ...row.section, recording: row.recording } : null;
    },

    /**
     * Pick a reading — an older one, or one recorded as another shot's
     * context — and put its cut clip on the shot in the SAME batch: a pointer
     * naming one reading while the shot holds another has no way back in the
     * UI (the pointed-at row shows as current, with no Use button).
     */
    selectSection: async (
      shotId: string,
      sectionId: string,
      audioClips: MotionAudioClip[]
    ): Promise<ShotDialogueSection> => {
      const [section] = await db
        .select()
        .from(shotDialogueSections)
        .where(
          and(
            eq(shotDialogueSections.id, sectionId),
            eq(shotDialogueSections.shotId, shotId)
          )
        )
        .limit(1);
      if (!section) {
        throw new Error(
          `Shot dialogue section ${sectionId} not found for shot ${shotId}`
        );
      }
      if (section.discardedAt) {
        throw new Error(`Shot dialogue section ${sectionId} was discarded`);
      }
      const [, selected] = await db.batch([
        clearSelectedSection(shotId),
        db
          .update(shotDialogueSections)
          .set({ selectedAt: new Date() })
          .where(eq(shotDialogueSections.id, section.id))
          .returning(),
        db
          .update(shots)
          .set({ audioClips, updatedAt: new Date() })
          .where(eq(shots.id, shotId)),
      ]);
      const [row] = selected;
      if (!row) {
        throw new Error(`Failed to select dialogue section ${sectionId}`);
      }
      return row;
    },
  };
}
