/**
 * Scoped Shot Dialogue Sub-module (#1657).
 *
 * Three append-only tables:
 *
 *   `shot_dialogue_versions` — the authored lines of one shot, one selected
 *     row per shot. The shot-list pass seeds a `prompt` row; a user edit
 *     appends `user-edit`. This is what References records and what render
 *     and staleness read.
 *   `dialogue_speeches` — one row per ElevenLabs Text to Dialogue call, the
 *     whole file. No selected flag: a speech is never "the" speech of
 *     anything, it is what sections point into.
 *   `shot_dialogue_sections` — a shot's time range of a speech, one
 *     selected row per shot. A speech inserts a section for every shot it
 *     spoke and selects only the shots that adopt it, so a shot that was only
 *     context keeps the reading it had. `shots.audioClips` holds the cut file
 *     of the selected section (working set).
 *
 * Every selection change is one `db.batch` — D1 has no interactive
 * transactions, and the partial unique index on `selectedAt` would reject a
 * clear-then-set done as two round trips that raced.
 */

import type { Database } from '@/platform/server/db/client';
import { NotFoundError } from '@/platform/errors';
import {
  dialogueSpeeches,
  shotDialogueClaims,
  shotDialogueSections,
  shotDialogueVersions,
  shots,
} from '@/platform/server/db/schema';
import type {
  DialogueSpeech,
  MotionAudioClip,
  DialogueSpeechTurn,
  ShotDialogueClaim,
  ShotDialogueLine,
  ShotDialogueSection,
  ShotDialogueSource,
  ShotDialogueVersion,
} from '@/platform/server/db/schema';
import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  sql,
} from 'drizzle-orm';

export type AppendDialogueSpeechInput = {
  /** Generated inside the workflow step, so a replay lands on the same rows. */
  id: string;
  sequenceId: string;
  storageKey: string;
  url: string;
  durationSeconds: number;
  turns: DialogueSpeechTurn[];
  inputHash: string;
  characterCount: number;
  /** Null for a speech no workflow made. */
  workflowRunId: string | null;
  /** What an adopting section is: a generated speech, or a mic take (#1802). */
  adoptedAs: 'generated' | 'mic';
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
    /**
     * Set for a shot this speech was made FOR: the claim that has to still
     * be live for the reading to become the shot's audio, and the clip cut
     * from it. Null = spoken as context only.
     */
    adopt: { claimId: string; audioClips: MotionAudioClip[] } | null;
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

  /** The claim may still become the shot's audio — see `shot-dialogue-claims.ts`. */
  const claimIsLive = (claimId: string) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(shotDialogueClaims)
        .where(
          and(
            eq(shotDialogueClaims.id, claimId),
            eq(shotDialogueClaims.status, 'generating'),
            isNotNull(shotDialogueClaims.pendingSourceKey)
          )
        )
    );

  /**
   * The user did something that should win over any speech in flight for
   * this shot (picked a reading, changed or restored the lines). The run
   * still finishes and its reading is kept — it just cannot take the
   * selection any more. Rides in the SAME batch as the user's write.
   */
  const demoteLiveClaims = (shotId: string) =>
    db
      .update(shotDialogueClaims)
      .set({ pendingSourceKey: null })
      .where(
        and(
          eq(shotDialogueClaims.shotId, shotId),
          eq(shotDialogueClaims.status, 'generating'),
          isNotNull(shotDialogueClaims.pendingSourceKey)
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

    /** Every authored version of a shot's lines, newest first. */
    listVersions: async (shotId: string): Promise<ShotDialogueVersion[]> =>
      await db
        .select()
        .from(shotDialogueVersions)
        .where(eq(shotDialogueVersions.shotId, shotId))
        .orderBy(
          desc(shotDialogueVersions.createdAt),
          desc(shotDialogueVersions.id)
        ),

    /**
     * Point the shot back at an earlier set of lines. The pointer is the whole
     * change: every reader resolves what a shot says from the selected row,
     * so the prompt text, the speech and the panel all follow. Readings
     * are not touched — the current one stops matching (so the next render
     * records), and any reading of the restored wording becomes usable again.
     */
    selectVersion: async (
      shotId: string,
      versionId: string
    ): Promise<ShotDialogueVersion> => {
      const [version] = await db
        .select()
        .from(shotDialogueVersions)
        .where(
          and(
            eq(shotDialogueVersions.id, versionId),
            eq(shotDialogueVersions.shotId, shotId)
          )
        )
        .limit(1);
      if (!version) {
        throw new NotFoundError(
          `Shot dialogue version ${versionId} not found for shot ${shotId}`
        );
      }
      const [, , selected] = await db.batch([
        demoteLiveClaims(shotId),
        clearSelectedVersion(shotId),
        db
          .update(shotDialogueVersions)
          .set({ selectedAt: new Date() })
          .where(eq(shotDialogueVersions.id, version.id))
          .returning(),
      ]);
      const [row] = selected;
      if (!row) {
        throw new Error(`Failed to select dialogue version ${versionId}`);
      }
      return row;
    },

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
     * Every shot's selected section with its speech's turns, for one
     * sequence (#1853) — the shot view derives line timing from it.
     */
    getSelectedSectionsBySequence: async (
      sequenceId: string
    ): Promise<
      Array<{
        shotId: string;
        fromSeconds: number;
        toSeconds: number;
        speechTurns: DialogueSpeechTurn[];
      }>
    > =>
      db
        .select({
          shotId: shotDialogueSections.shotId,
          fromSeconds: shotDialogueSections.fromSeconds,
          toSeconds: shotDialogueSections.toSeconds,
          speechTurns: dialogueSpeeches.turns,
        })
        .from(shotDialogueSections)
        .innerJoin(shots, eq(shots.id, shotDialogueSections.shotId))
        .innerJoin(
          dialogueSpeeches,
          eq(dialogueSpeeches.id, shotDialogueSections.speechId)
        )
        .where(
          and(
            eq(shots.sequenceId, sequenceId),
            isNull(shots.deletedAt),
            isNotNull(shotDialogueSections.selectedAt)
          )
        ),

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
      const [, , inserted] = await db.batch([
        // The words moved: a speech in flight speaks the old ones.
        demoteLiveClaims(shotId),
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
     * Claim the shots a speech is about to be made for (#1657). Returns
     * shot id → claim id for the shots THIS run now holds. A shot missing from
     * the result is already being recorded, for the same words, by another
     * run — the live unique index refused the insert — so this run must not
     * adopt it. Safe under step replay: a claim this run already made is
     * found by its run id and handed back.
     */
    claimSpeech: async (input: {
      shots: ReadonlyArray<{ shotId: string; sourceKey: string }>;
      workflowRunId: string;
    }): Promise<Record<string, string>> => {
      if (input.shots.length === 0) return {};
      const [first, ...rest] = input.shots.map((shot) =>
        db
          .insert(shotDialogueClaims)
          .values({
            shotId: shot.shotId,
            sourceKey: shot.sourceKey,
            pendingSourceKey: shot.sourceKey,
            status: 'generating',
            workflowRunId: input.workflowRunId,
          })
          .onConflictDoNothing()
      );
      if (first) await db.batch([first, ...rest]);
      const mine = await db
        .select({
          id: shotDialogueClaims.id,
          shotId: shotDialogueClaims.shotId,
          sourceKey: shotDialogueClaims.sourceKey,
        })
        .from(shotDialogueClaims)
        .where(
          and(
            eq(shotDialogueClaims.workflowRunId, input.workflowRunId),
            eq(shotDialogueClaims.status, 'generating'),
            inArray(
              shotDialogueClaims.shotId,
              input.shots.map((shot) => shot.shotId)
            )
          )
        );
      const wanted = new Map(
        input.shots.map((shot) => [shot.shotId, shot.sourceKey])
      );
      return Object.fromEntries(
        mine
          .filter((claim) => wanted.get(claim.shotId) === claim.sourceKey)
          .map((claim) => [claim.shotId, claim.id])
      );
    },

    /** The recorder gave up: its claims must not read as "a job is fixing this". */
    failClaims: async (claimIds: readonly string[], error: string) => {
      if (claimIds.length === 0) return;
      await db
        .update(shotDialogueClaims)
        .set({ status: 'failed', pendingSourceKey: null, error })
        .where(
          and(
            inArray(shotDialogueClaims.id, [...claimIds]),
            eq(shotDialogueClaims.status, 'generating')
          )
        );
    },

    /**
     * The user does not want this speech to become the shot's audio. The
     * run is not stopped — it records the scene for other shots too — but its
     * reading for this shot lands unselected.
     */
    cancelClaim: async (shotId: string, claimId: string): Promise<boolean> => {
      const cancelled = await db
        .update(shotDialogueClaims)
        .set({ status: 'cancelled', pendingSourceKey: null })
        .where(
          and(
            eq(shotDialogueClaims.id, claimId),
            eq(shotDialogueClaims.shotId, shotId),
            eq(shotDialogueClaims.status, 'generating')
          )
        )
        .returning({ id: shotDialogueClaims.id });
      return cancelled.length > 0;
    },

    /** A shot's speeches in flight, newest first. */
    listLiveClaims: async (shotId: string): Promise<ShotDialogueClaim[]> =>
      await db
        .select()
        .from(shotDialogueClaims)
        .where(
          and(
            eq(shotDialogueClaims.shotId, shotId),
            eq(shotDialogueClaims.status, 'generating')
          )
        )
        .orderBy(desc(shotDialogueClaims.createdAt)),

    /**
     * The shots with a speech in flight that will become their audio —
     * the unique-index predicate, so a demoted claim does not count (#1816).
     */
    listShotIdsWithLiveClaim: async (
      shotIds: readonly string[]
    ): Promise<Set<string>> => {
      if (shotIds.length === 0) return new Set();
      const rows = await db
        .selectDistinct({ shotId: shotDialogueClaims.shotId })
        .from(shotDialogueClaims)
        .where(
          and(
            inArray(shotDialogueClaims.shotId, [...shotIds]),
            eq(shotDialogueClaims.status, 'generating'),
            isNotNull(shotDialogueClaims.pendingSourceKey)
          )
        );
      return new Set(rows.map((row) => row.shotId));
    },

    /**
     * Land one call: the speech, a section for every shot it spoke, and —
     * for each shot it was made FOR — the promotion, guarded by that shot's
     * claim (#1657).
     *
     * One transaction, and every promoting statement carries the same
     * `claimIsLive` predicate, so there is no gap between checking the claim
     * and acting on it: a reading becomes the shot's audio (pointer moved AND
     * `shots.audioClips` written) only if the claim is still live at that
     * moment. A claim the user demoted or cancelled meanwhile keeps its
     * reading — unselected, pickable later — and leaves the shot alone.
     * Context shots get an unselected row and keep what they had.
     *
     * Returns the shots that were promoted. Idempotent under replay: the ids
     * come from the caller, a speech that already exists means this batch
     * committed whole, and the answer is read back off the claims.
     * One statement per section keeps each under D1's 100-bound-parameter cap.
     */
    appendSpeech: async (
      input: AppendDialogueSpeechInput
    ): Promise<{ promotedShotIds: string[] }> => {
      const adopting = input.sections.flatMap((section) =>
        section.adopt ? [{ ...section, adopt: section.adopt }] : []
      );
      const promoted = async () => {
        if (adopting.length === 0) return { promotedShotIds: [] };
        const claims = await db
          .select({
            shotId: shotDialogueClaims.shotId,
            promotedAt: shotDialogueClaims.promotedAt,
          })
          .from(shotDialogueClaims)
          .where(
            inArray(
              shotDialogueClaims.id,
              adopting.map((section) => section.adopt.claimId)
            )
          );
        return {
          promotedShotIds: claims
            .filter((claim) => claim.promotedAt !== null)
            .map((claim) => claim.shotId),
        };
      };

      const [existing] = await db
        .select({ id: dialogueSpeeches.id })
        .from(dialogueSpeeches)
        .where(eq(dialogueSpeeches.id, input.id))
        .limit(1);
      if (existing) return await promoted();

      // The speech is a soft pointer, so no CHECK can say this.
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
          .insert(dialogueSpeeches)
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
        // Every reading lands unselected; promotion is the guarded part below.
        ...input.sections.map((section) =>
          db
            .insert(shotDialogueSections)
            .values({
              id: section.id,
              shotId: section.shotId,
              speechId: input.id,
              fromSeconds: section.fromSeconds,
              toSeconds: section.toSeconds,
              sourceKey: section.sourceKey,
              spokenLines: section.spokenLines,
              dialogueVersionId: section.dialogueVersionId,
              source: section.adopt ? input.adoptedAs : 'context',
              workflowRunId: input.workflowRunId,
            })
            .onConflictDoNothing()
        ),
        // Promote, per shot, only while its claim is live. Clear before
        // select — the partial unique index rejects the other order. The
        // claim is completed LAST, so the three guards above it all see it
        // live or all see it gone.
        ...adopting.flatMap((section) => {
          const live = claimIsLive(section.adopt.claimId);
          return [
            db
              .update(shotDialogueSections)
              .set({ selectedAt: null })
              .where(
                and(
                  eq(shotDialogueSections.shotId, section.shotId),
                  isNotNull(shotDialogueSections.selectedAt),
                  live
                )
              ),
            db
              .update(shotDialogueSections)
              .set({ selectedAt: now })
              .where(and(eq(shotDialogueSections.id, section.id), live)),
            db
              .update(shots)
              .set({ audioClips: section.adopt.audioClips, updatedAt: now })
              .where(and(eq(shots.id, section.shotId), live)),
            db
              .update(shotDialogueClaims)
              .set({
                status: 'completed',
                sectionId: section.id,
                promotedAt: sql`CASE WHEN ${shotDialogueClaims.pendingSourceKey} IS NOT NULL THEN ${Math.floor(now.getTime() / 1000)} END`,
                pendingSourceKey: null,
              })
              .where(
                and(
                  eq(shotDialogueClaims.id, section.adopt.claimId),
                  eq(shotDialogueClaims.status, 'generating')
                )
              ),
          ];
        }),
      ]);
      return await promoted();
    },

    /** Each speech's file, turns and when it was made, by id (#1802). */
    listSpeeches: async (
      speechIds: readonly string[]
    ): Promise<
      Map<string, { url: string; turns: DialogueSpeechTurn[]; createdAt: Date }>
    > => {
      const ids = [...new Set(speechIds)];
      const out = new Map<
        string,
        { url: string; turns: DialogueSpeechTurn[]; createdAt: Date }
      >();
      // Under D1's 100-bound-parameter cap (#1019).
      for (let i = 0; i < ids.length; i += 90) {
        const rows = await db
          .select({
            id: dialogueSpeeches.id,
            url: dialogueSpeeches.url,
            turns: dialogueSpeeches.turns,
            createdAt: dialogueSpeeches.createdAt,
          })
          .from(dialogueSpeeches)
          .where(inArray(dialogueSpeeches.id, ids.slice(i, i + 90)));
        for (const { id, ...speech } of rows) out.set(id, speech);
      }
      return out;
    },

    /** A shot's readings, newest first, each with the file it points into. */
    listSections: async (
      shotId: string
    ): Promise<
      Array<
        ShotDialogueSection & {
          speechUrl: string;
          speechTurns: DialogueSpeechTurn[];
        }
      >
    > => {
      const rows = await db
        .select({
          section: shotDialogueSections,
          speechUrl: dialogueSpeeches.url,
          speechTurns: dialogueSpeeches.turns,
        })
        .from(shotDialogueSections)
        .innerJoin(
          dialogueSpeeches,
          eq(dialogueSpeeches.id, shotDialogueSections.speechId)
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
        speechUrl: row.speechUrl,
        speechTurns: row.speechTurns,
      }));
    },

    getSectionById: async (
      sectionId: string
    ): Promise<(ShotDialogueSection & { speech: DialogueSpeech }) | null> => {
      const [row] = await db
        .select({
          section: shotDialogueSections,
          speech: dialogueSpeeches,
        })
        .from(shotDialogueSections)
        .innerJoin(
          dialogueSpeeches,
          eq(dialogueSpeeches.id, shotDialogueSections.speechId)
        )
        .where(eq(shotDialogueSections.id, sectionId))
        .limit(1);
      return row ? { ...row.section, speech: row.speech } : null;
    },

    /**
     * Soft-discard a reading. A discarded section can never stay selected, and
     * the shot must not keep a clip cut from it — so discarding the CURRENT
     * reading clears `shots.audioClips` in the same batch, and the next render
     * records afresh. The speech file is untouched: other shots may hold
     * sections of it.
     */
    discardSection: async (
      shotId: string,
      sectionId: string
    ): Promise<void> => {
      const [section] = await db
        .select({ selectedAt: shotDialogueSections.selectedAt })
        .from(shotDialogueSections)
        .where(
          and(
            eq(shotDialogueSections.id, sectionId),
            eq(shotDialogueSections.shotId, shotId)
          )
        )
        .limit(1);
      if (!section) {
        throw new NotFoundError(
          `Shot dialogue section ${sectionId} not found for shot ${shotId}`
        );
      }
      const discard = db
        .update(shotDialogueSections)
        .set({ discardedAt: new Date(), selectedAt: null })
        .where(eq(shotDialogueSections.id, sectionId));
      if (!section.selectedAt) {
        await discard;
        return;
      }
      await db.batch([
        discard,
        db
          .update(shots)
          .set({ audioClips: [], updatedAt: new Date() })
          .where(eq(shots.id, shotId)),
      ]);
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
      const [, , selected] = await db.batch([
        // A reading picked by hand outranks one still being recorded.
        demoteLiveClaims(shotId),
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
