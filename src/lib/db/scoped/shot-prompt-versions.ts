/**
 * Scoped Shot Prompt Versions Sub-module
 *
 * Appends a new revision row to `shot_prompt_versions` and points
 * `shots.selectedMotionPromptVersionId` at it. The version row is the only
 * source: its `text` is the prompt and its `inputHash` is the upstream context
 * staleness compares against. Renamed from `shot-prompt-variants` in #988.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import type {
  MotionAudio,
  MotionDialogue,
  MotionPromptParameters,
} from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { shotPromptVersions, shots, user } from '@/lib/db/schema';
import type {
  ShotPromptType,
  ShotPromptVersion,
  ShotPromptVersionComponents,
} from '@/lib/db/schema';
import { getLogger } from '@/lib/observability/logger';
import { and, desc, eq, gt, inArray, isNotNull, lte, ne } from 'drizzle-orm';
import { LIVE_PENDING_STATUSES } from './frame-prompt-versions';
import { buildEventInsert } from './sequence-events';

const logger = getLogger(['openstory', 'db', 'shot-prompt-versions']);

// `getSelectedMotionByShots` binds one id param per shot; 90 keeps each query
// under D1's 100-bound-parameter ceiling (matches SHOTS_BY_IDS_BATCH).
const SELECTED_MOTION_BY_SHOTS_BATCH = 90;

type WriteShotPromptVersionBase = {
  shotId: string;
  promptType: ShotPromptType;
  text: string;
  components?: ShotPromptVersionComponents | null;
  parameters?: MotionPromptParameters | null;
  /**
   * Motion-only: the scene dialogue/audio direction the prompt was authored
   * with. Persisted on the version so audio-capable video models can append
   * them at render time without re-reading `metadata.prompts.motion` (#713).
   */
  dialogue?: MotionDialogue | null;
  audio?: MotionAudio | null;
  /**
   * The mode this text was authored for (`usesStartFrame(shot, sequence)` at
   * write time; a restore copies its source row's). Required: a forgotten stamp
   * is silent for ever. Restoring a pre-stamp (null) row must resolve it fresh.
   */
  usesStartFrame: boolean;
  createdBy?: string | null;
  /**
   * `false`: append to history only — the shot keeps its selected prompt.
   * A variant-only render's content-checker rescue (#1373) writes its
   * rewrite this way so an alternate model never moves the primary prompt.
   */
  select?: boolean;
};

/**
 * `inputHash` represents the upstream context (scene + style + narrowed
 * bibles + aspectRatio + analysisModel) that this prompt is aligned with,
 * regardless of who authored the text. Every row persists it verbatim — it is
 * what staleness compares against, so discarding it would silently freeze
 * detection. User-edits carry the live hash captured at edit time; null is
 * permitted only when the upstream context was uncomputable at write time
 * (e.g. style deleted), in which case the staleness function falls back to an
 * earlier non-null row.
 *
 * Restored rows carry the source version's hash + analysisModel verbatim, so
 * restoring an old AI prompt does not disable staleness detection. Both fields
 * stay nullable for restored rows to accommodate legacy user-edit rows written
 * before this contract landed (null hashes we can't retroactively recompute).
 */
export type WriteShotPromptVersionInput = WriteShotPromptVersionBase &
  (
    | {
        source: 'ai-generated' | 'regenerated';
        inputHash: string;
        analysisModel: string;
      }
    | {
        source: 'user-edit';
        inputHash: string | null;
        analysisModel: string | null;
      }
    | {
        // `restored`: audit row for a repoint. `softened`: the content-checker
        // rewrite the clip was re-rendered from (#1373); carries the rejected
        // version's hash + model verbatim so staleness stays detectable.
        source: 'restored' | 'softened';
        inputHash: string | null;
        analysisModel: string | null;
      }
  );

// Visual (image) prompt versions moved to `frame_prompt_versions` (#989), so
// every write through this module must be motion.
const assertMotionPromptType = (promptType: ShotPromptType): void => {
  if (promptType === 'visual') {
    throw new Error(
      'Visual prompt versions moved to frame_prompt_versions (#989); use scopedDb.framePromptVersions'
    );
  }
};

export function createShotPromptVersionsMethods(db: Database) {
  /**
   * Point the shot at `version`. The render manifest references this pointer
   * (motion prompt version snapshot, #990), so a null here means the manifest
   * records no prompt.
   */
  const selectVersion = (shotId: string, versionId: string) =>
    db
      .update(shots)
      .set({
        selectedMotionPromptVersionId: versionId,
        updatedAt: new Date(),
      })
      .where(eq(shots.id, shotId));

  /**
   * Revoke the mirror right of every live motion claim on this shot (#1085)
   * — see `framePromptVersions`' demote helper for the contract: an explicit
   * user repoint/edit wins over any in-flight regeneration, whose output then
   * lands in history only. Also frees the live-claim unique index slot.
   */
  const demoteLiveClaims = (shotId: string) =>
    db
      .update(shotPromptVersions)
      .set({ pendingInputHash: null })
      .where(
        and(
          eq(shotPromptVersions.shotId, shotId),
          eq(shotPromptVersions.promptType, 'motion'),
          inArray(shotPromptVersions.status, [...LIVE_PENDING_STATUSES])
        )
      );

  /**
   * Post-transition mirror check for completePendingAiVersion (#1095 TOCTOU).
   * See framePromptVersions.stillHoldsMirrorRight for the race rationale.
   */
  const stillHoldsMirrorRight = async (
    shotId: string,
    claimId: string
  ): Promise<boolean> => {
    const [row] = await db
      .select({ pendingInputHash: shotPromptVersions.pendingInputHash })
      .from(shotPromptVersions)
      .where(eq(shotPromptVersions.id, claimId))
      .limit(1);
    if (!row || row.pendingInputHash === null) return false;
    const [newer] = await db
      .select({ id: shotPromptVersions.id })
      .from(shotPromptVersions)
      .where(
        and(
          eq(shotPromptVersions.shotId, shotId),
          eq(shotPromptVersions.promptType, 'motion'),
          eq(shotPromptVersions.status, 'completed'),
          gt(shotPromptVersions.id, claimId)
        )
      )
      .limit(1);
    return !newer;
  };

  const methods = {
    /**
     * Append a new prompt version row and point the shot at it. Returns the
     * inserted (or pre-existing matching) row.
     *
     * Retry idempotency is `(shot, prompt_type, input_hash, text)` — same
     * upstream context AND same output. A force-regen produces new text at an
     * unchanged hash and so appends, keeping its real hash. A restore always
     * appends its audit row.
     *
     * Durability: the insert + pointer update are sequential, not
     * transactional; the append happens first so a crash can never leave a
     * pointer with no row behind it.
     */
    write: async (
      input: WriteShotPromptVersionInput
    ): Promise<ShotPromptVersion> => {
      assertMotionPromptType(input.promptType);

      const nextHash = input.inputHash;
      const analysisModel = input.analysisModel;

      // A workflow step retry re-submits the same output for the same context.
      // Same context but NEW text is a force-regen and must append.
      let version: ShotPromptVersion | undefined;
      // A restore always appends its audit row, even at identical content.
      if (nextHash !== null && input.source !== 'restored') {
        [version] = await db
          .select()
          .from(shotPromptVersions)
          .where(
            and(
              eq(shotPromptVersions.shotId, input.shotId),
              eq(shotPromptVersions.promptType, input.promptType),
              eq(shotPromptVersions.inputHash, nextHash),
              eq(shotPromptVersions.text, input.text),
              ne(shotPromptVersions.source, 'restored')
            )
          )
          .limit(1);
      }

      if (!version) {
        [version] = await db
          .insert(shotPromptVersions)
          .values({
            shotId: input.shotId,
            promptType: input.promptType,
            text: input.text,
            components: input.components,
            parameters: input.parameters,
            dialogue: input.dialogue,
            audio: input.audio,
            usesStartFrame: input.usesStartFrame,
            source: input.source,
            inputHash: nextHash,
            analysisModel,
            createdBy: input.createdBy ?? null,
          })
          .returning();
      }

      if (!version) {
        throw new Error('Failed to insert shot prompt version');
      }
      if (input.select === false) return version;

      // Mirror onto the shot AND repoint the selection at this version. The
      // `selectedMotionPromptVersionId` pointer was previously never set, so the
      // render manifest snapshotted a null motion-prompt reference (#990 bug);
      // setting it here is load-bearing. The cached hash tracks `nextHash` (the
      // real upstream context) even on the force-regen path where the version row
      // itself carries a null hash — see the branch above.
      // Demote live claims in the same batch so a concurrent
      // completePendingAiVersion cannot clobber this write (#1095 TOCTOU).
      await db.batch([
        selectVersion(input.shotId, version.id),
        demoteLiveClaims(input.shotId),
      ]);

      return version;
    },

    /**
     * Append an AI-generated MOTION prompt version, deciding `ai-generated`
     * (first motion version for the shot) vs `regenerated` (a re-run) from the
     * shot's existing motion history — so the generation workflow doesn't
     * compute `source` or chase `getLatest` itself. Appends + mirrors via
     * `write`. The dedupe/force-regen contract is `write`'s.
     */
    writeAiVersion: async (input: {
      shotId: string;
      text: string;
      components?: ShotPromptVersionComponents | null;
      parameters?: MotionPromptParameters | null;
      dialogue?: MotionDialogue | null;
      audio?: MotionAudio | null;
      usesStartFrame: boolean;
      inputHash: string;
      analysisModel: string;
      createdBy?: string | null;
    }): Promise<ShotPromptVersion> => {
      const previous = await methods.getLatest(input.shotId, 'motion');
      return methods.write({
        ...input,
        promptType: 'motion',
        source: previous ? 'regenerated' : 'ai-generated',
      });
    },

    /**
     * Create an in-flight placeholder motion row for an enqueued regeneration
     * (#1085). Does NOT mirror or repoint — only completion does — so the
     * selection pointer keeps its "completed rows only" invariant. Mirrors
     * `framePromptVersions.createPending`.
     */
    createPending: async (input: {
      shotId: string;
      pendingInputHash: string;
      // The mode the run will author for; the claim carries it from the
      // start so no row ever holds the column's default as a placeholder.
      usesStartFrame: boolean;
      workflowRunId?: string | null;
      createdBy?: string | null;
    }): Promise<ShotPromptVersion> => {
      const [row] = await db
        .insert(shotPromptVersions)
        .values({
          shotId: input.shotId,
          promptType: 'motion',
          text: '',
          usesStartFrame: input.usesStartFrame,
          source: 'regenerated',
          inputHash: null,
          analysisModel: null,
          status: 'pending',
          pendingInputHash: input.pendingInputHash,
          workflowRunId: input.workflowRunId ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      if (!row) throw new Error('Failed to insert pending motion prompt row');
      return row;
    },

    /**
     * Newest live (pending/generating) motion claim satisfying
     * `pendingInputHash` — the dedup + "updating" staleness probe.
     */
    getLivePending: async (
      shotId: string,
      pendingInputHash: string
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, 'motion'),
            eq(shotPromptVersions.pendingInputHash, pendingInputHash),
            inArray(shotPromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },

    /** Claim → 'generating' + stamp the working instance; false if the claim
     * went terminal meanwhile (caller must abandon the generation). */
    markGenerating: async (
      versionId: string,
      workflowRunId: string
    ): Promise<boolean> => {
      const updated = await db
        .update(shotPromptVersions)
        .set({ status: 'generating', workflowRunId })
        .where(
          and(
            eq(shotPromptVersions.id, versionId),
            inArray(shotPromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning({ id: shotPromptVersions.id });
      return updated.length > 0;
    },

    /** Terminal-fail a live claim; null when it was already terminal. */
    markTerminal: async (
      versionId: string,
      status: 'failed' | 'cancelled'
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .update(shotPromptVersions)
        .set({ status })
        .where(
          and(
            eq(shotPromptVersions.id, versionId),
            inArray(shotPromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning();
      return row ?? null;
    },

    /**
     * Complete a pending motion claim in place. Same contract as
     * `framePromptVersions.completePendingAiVersion`: mirrors onto the shot
     * only when no newer completed row landed meanwhile (post-click edits are
     * never clobbered); returns null when the claim was cancelled mid-flight;
     * handles the partial-unique-index collision like `write`.
     */
    completePendingAiVersion: async (input: {
      versionId: string;
      shotId: string;
      text: string;
      components?: ShotPromptVersionComponents | null;
      parameters?: MotionPromptParameters | null;
      dialogue?: MotionDialogue | null;
      audio?: MotionAudio | null;
      usesStartFrame: boolean;
      inputHash: string;
      analysisModel: string;
    }): Promise<ShotPromptVersion | null> => {
      const [claim] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.id, input.versionId),
            eq(shotPromptVersions.shotId, input.shotId)
          )
        )
        .limit(1);
      if (!claim) {
        throw new Error(
          `ShotPromptVersion ${input.versionId} not found for shot ${input.shotId}`
        );
      }

      const [conflicting] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, input.shotId),
            eq(shotPromptVersions.promptType, 'motion'),
            eq(shotPromptVersions.inputHash, input.inputHash),
            ne(shotPromptVersions.id, input.versionId),
            ne(shotPromptVersions.source, 'restored')
          )
        )
        .limit(1);

      if (conflicting && conflicting.text === input.text) {
        // Guarded retire — a no-op means a cancel already won the race, and
        // cancelled work must not mirror (same contract as the main branch).
        // status 'cancelled' = retired duplicate placeholder, not user cancel.
        const retired = await db
          .update(shotPromptVersions)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(shotPromptVersions.id, input.versionId),
              inArray(shotPromptVersions.status, [...LIVE_PENDING_STATUSES])
            )
          )
          .returning({ id: shotPromptVersions.id });
        if (retired.length === 0) return null;
        // Re-evaluate AFTER the terminal transition (#1095 TOCTOU).
        if (await stillHoldsMirrorRight(input.shotId, claim.id)) {
          await selectVersion(input.shotId, conflicting.id);
        }
        return conflicting;
      }

      const [updated] = await db
        .update(shotPromptVersions)
        .set({
          text: input.text,
          components: input.components ?? null,
          parameters: input.parameters ?? null,
          dialogue: input.dialogue ?? null,
          audio: input.audio ?? null,
          usesStartFrame: input.usesStartFrame,
          inputHash: input.inputHash,
          analysisModel: input.analysisModel,
          status: 'completed',
        })
        .where(
          and(
            eq(shotPromptVersions.id, input.versionId),
            inArray(shotPromptVersions.status, [...LIVE_PENDING_STATUSES])
          )
        )
        .returning();
      if (!updated) return null; // cancelled mid-flight — discard the output

      // Mirror right re-checked after we own the terminal write (#1085/#1095).
      if (await stillHoldsMirrorRight(input.shotId, claim.id)) {
        await selectVersion(input.shotId, updated.id);
      }
      return updated;
    },

    /**
     * The motion prompt version the shot currently points at via
     * `shots.selectedMotionPromptVersionId`, or null. This is the resolution
     * source of truth (#713): the render path reconstructs the `MotionPrompt`
     * from this row rather than reading `metadata.prompts.motion`.
     */
    getSelectedMotion: async (
      shotId: string
    ): Promise<ShotPromptVersion | null> => {
      // Left join (not inner) so "no pointer set" is distinguishable from
      // "pointer set but the row is gone" — an orphaned pointer (broken FK /
      // deleted version) that an inner join would drop silently.
      const [row] = await db
        .select({
          pointer: shots.selectedMotionPromptVersionId,
          version: shotPromptVersions,
        })
        .from(shots)
        .leftJoin(
          shotPromptVersions,
          eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
        )
        .where(eq(shots.id, shotId))
        .limit(1);
      if (row?.pointer && !row.version) {
        logger.warn(
          `Shot ${shotId} points at motion prompt version ${row.pointer} but no row exists (orphaned pointer)`
        );
      }
      return row?.version ?? null;
    },

    /**
     * Selected motion prompt version for each shot, keyed by shotId. Shots with
     * no selected motion version are absent from the map.
     *
     * Read paths that assemble a `ShotView` get this from the join in
     * `shot-view-query.ts` instead; this serves callers that hold shot ids
     * only.
     */
    getSelectedMotionByShots: async (
      shotIds: string[]
    ): Promise<Map<string, ShotPromptVersion>> => {
      if (shotIds.length === 0) return new Map();
      const result = new Map<string, ShotPromptVersion>();
      for (let i = 0; i < shotIds.length; i += SELECTED_MOTION_BY_SHOTS_BATCH) {
        const rows = await db
          .select({ shotId: shots.id, version: shotPromptVersions })
          .from(shots)
          .innerJoin(
            shotPromptVersions,
            eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
          )
          .where(
            inArray(
              shots.id,
              shotIds.slice(i, i + SELECTED_MOTION_BY_SHOTS_BATCH)
            )
          );
        for (const r of rows) result.set(r.shotId, r.version);
      }
      return result;
    },

    /**
     * Repoint the shot at an existing motion prompt version (a restore / undo)
     * and mirror it onto the shot, committing the change and a
     * `prompt.selected` event in one batch. Returns the selected version.
     * Mirrors `framePromptVersions.select`.
     */
    select: async (
      shotId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<ShotPromptVersion> => {
      const [version] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.id, versionId),
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, 'motion')
          )
        );
      if (!version) {
        throw new Error(
          `Motion ShotPromptVersion ${versionId} not found for shot ${shotId}`
        );
      }
      if (version.status !== 'completed') {
        // The selection pointer may only reference completed rows — same
        // invariant as frameVariants.select / framePromptVersions.select.
        throw new Error(
          `Motion ShotPromptVersion ${versionId} is ${version.status}, not completed`
        );
      }
      const [shot] = await db
        .select({
          sequenceId: shots.sequenceId,
          prev: shots.selectedMotionPromptVersionId,
        })
        .from(shots)
        .where(eq(shots.id, shotId));
      if (!shot) {
        throw new Error(`Shot ${shotId} not found`);
      }

      await db.batch([
        selectVersion(shotId, version.id),
        // An explicit repoint revokes in-flight claims' mirror rights (#1085).
        demoteLiveClaims(shotId),
        buildEventInsert(db, {
          sequenceId: shot.sequenceId,
          actorId: opts.actorId,
          kind: 'prompt.selected',
          targetType: 'shot',
          targetId: shotId,
          summary: 'Restored motion prompt',
          data: { versionId, prevVersionId: shot.prev ?? null },
        }),
      ]);
      return version;
    },

    /** List the revision history for a shot's prompt, newest first. */
    listByShot: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVersion[]> => {
      return await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt));
    },

    /**
     * History list for the UI — joins author name. Newest first.
     */
    listByShotWithAuthor: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<Array<ShotPromptVersion & { createdByName: string | null }>> => {
      const rows = await db
        .select({ version: shotPromptVersions, createdByName: user.name })
        .from(shotPromptVersions)
        .leftJoin(user, eq(shotPromptVersions.createdBy, user.id))
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt));
      return rows.map((r) => ({
        ...r.version,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single version scoped to its shot. */
    getByIdForShot: async (
      versionId: string,
      shotId: string
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.id, versionId),
            eq(shotPromptVersions.shotId, shotId)
          )
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * Candidates for matching a `shot_variants.promptHash` (`simpleHash` of
     * the prompt text) — pulls prompt versions of the right type that existed
     * at or before `cutoff`, newest first. Caller filters by simpleHash.
     */
    listCandidatesAtOrBefore: async (
      shotId: string,
      promptType: ShotPromptType,
      cutoff: Date,
      limit = 50
    ): Promise<ShotPromptVersion[]> => {
      return await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType),
            lte(shotPromptVersions.createdAt, cutoff),
            // In-flight/failed placeholders can't match a render's promptHash
            // and would waste candidate slots in the limited window.
            eq(shotPromptVersions.status, 'completed')
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(limit);
    },

    /** Most recent completed version of a given type, or null. In-flight and
     * failed rows are placeholders, not content. */
    getLatest: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType),
            eq(shotPromptVersions.status, 'completed')
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },

    /**
     * Most recent version of a given type whose `inputHash` is non-null.
     * Used by the staleness path to find a reference hash for legacy shots
     * whose cached `*_prompt_input_hash` column was nulled out by a
     * pre-fix user-edit. Skips user-edit rows that fell back to null when
     * context was uncomputable.
     */
    getLatestWithInputHash: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType),
            isNotNull(shotPromptVersions.inputHash),
            eq(shotPromptVersions.status, 'completed')
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
  return methods;
}
