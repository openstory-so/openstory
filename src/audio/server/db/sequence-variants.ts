import { NotFoundError, ValidationError } from '@/platform/errors';
/**
 * Scoped Sequence Variants Sub-module — music tracks (#1115).
 *
 * `sequence_music_variants` is append-only: every generation, upload and
 * add-model run is its own row. The sequence plays the row
 * `sequences.selectedMusicVariantId` points at, and a primary run's result
 * reaches that pointer only through the claim
 * `sequences.pendingPromoteMusicVariantId` (#1130):
 *
 *   claimMusic → (stampMusicRun) → completeMusicClaim | failMusicClaim
 *
 * `selectMusic` is the user's selector. The newest `isPrimary` row's lifecycle
 * is the sequence's music status (projected by `sequenceColumns`).
 */

import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import { sequenceMusicVariants, sequences } from '@/platform/server/db/schema';
import { selectSequencesFrom } from '@/sequences/server/db/sequences';
import type {
  Sequence,
  SequenceMusicVariant,
} from '@/platform/server/db/schema';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { pageOf } from '@/platform/server/db/read-page';
import type { VersionListOptions } from '@/platform/server/db/read-page';
import type { SequenceMusicInputHash } from '@/shots/input-hash';

/** What a music run is asked to make — stamped on its row. */
type MusicRunInputs = {
  model: string;
  prompt: string | null;
  tags: string | null;
  durationSeconds: number | null;
};

export type ClaimMusicInput = MusicRunInputs & {
  sequenceId: string;
  /**
   * A primary run takes the pointer claim with its row; an added model's run
   * (#547) only opens its row.
   */
  isPrimary: boolean;
  workflowRunId: string | null;
  /**
   * Compare-and-swap on the claim: take it only while it still names this
   * (null = no primary run in flight). Omitted = last kickoff wins (#1070).
   */
  ifPendingIs?: string | null;
  /**
   * The row id, minted in an earlier durable step so a retried claim step
   * finds its own row rather than a busy claim. Omitted = a fresh id.
   */
  id?: string;
};

export type CompleteMusicClaimInput = {
  sequenceId: string;
  url: string;
  storagePath: string;
  durationSeconds: number;
  inputHash: SequenceMusicInputHash;
};

export type FailMusicClaimInput = {
  sequenceId: string;
  /** The row the trigger opened, when there is one. */
  variantId?: string;
  /** The row the run opened itself. */
  workflowRunId?: string;
  /**
   * When neither names a row — the run died before opening one — append a
   * terminal failed primary row for this model, so the failure is a record
   * the sequence reads, not a gap.
   */
  recordIfMissing?: { model: string };
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function createSequenceVariantsMethods(db: Database) {
  const getMusicById = async (
    variantId: string
  ): Promise<SequenceMusicVariant | null> => {
    const result = await db
      .select()
      .from(sequenceMusicVariants)
      .where(eq(sequenceMusicVariants.id, variantId));
    return result.at(0) ?? null;
  };

  const readSequence = async (sequenceId: string): Promise<Sequence> => {
    const [row] = await selectSequencesFrom(db).where(
      eq(sequences.id, sequenceId)
    );
    if (!row) throw new Error(`Sequence ${sequenceId} not found`);
    return row;
  };

  /** A terminal failed primary row: the failure the sequence reads. */
  const recordMusicFailure = async (input: {
    sequenceId: string;
    model: string;
    error: string;
    workflowRunId: string | null;
  }): Promise<void> => {
    await db.insert(sequenceMusicVariants).values({
      sequenceId: input.sequenceId,
      model: input.model,
      status: 'failed',
      error: input.error,
      isPrimary: true,
      workflowRunId: input.workflowRunId,
    });
  };

  return {
    // ── Reads ─────────────────────────────────────────────────────────────
    /**
     * Every music track of a sequence, oldest first (id order — callers take
     * a model's newest from the end). Unlike the other version
     * lists this one has always returned discarded rows too, so
     * `includeDiscarded` defaults to true here; pass `false` to drop them.
     */
    listMusicBySequence: async (
      sequenceId: string,
      options?: VersionListOptions
    ): Promise<SequenceMusicVariant[]> => {
      return await pageOf(
        db.select().from(sequenceMusicVariants).$dynamic(),
        and(
          eq(sequenceMusicVariants.sequenceId, sequenceId),
          (options?.includeDiscarded ?? true)
            ? undefined
            : isNull(sequenceMusicVariants.discardedAt)
        ),
        sequenceMusicVariants.id,
        options?.page,
        asc(sequenceMusicVariants.id)
      );
    },

    /**
     * Distinct audio models with a track that is not parked (#546). Drives
     * the header audio-model dropdown.
     */
    listMusicModels: async (sequenceId: string): Promise<string[]> => {
      const result = await db
        .selectDistinct({ model: sequenceMusicVariants.model })
        .from(sequenceMusicVariants)
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, sequenceId),
            isNull(sequenceMusicVariants.divergedAt)
          )
        );
      return result.map((r) => r.model);
    },

    getMusicById,

    // ── The claim lifecycle (#1130) ───────────────────────────────────────
    /**
     * Open a track run's row, `pending`, before anything is spent. A primary
     * run also takes the pointer claim — in one batch whose INSERT only lands
     * if the claim does, so a lost compare-and-swap (`ifPendingIs`) opens
     * nothing. Returns the new row's id, or null when the claim was busy.
     * Idempotent per `id`: a row already open under it is returned as is.
     */
    claimMusic: async (input: ClaimMusicInput): Promise<string | null> => {
      const id = input.id ?? generateId();
      const at = new Date();
      const opened = db
        .select({ id: sequenceMusicVariants.id })
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.id, id));
      if (!input.isPrimary) {
        await db
          .insert(sequenceMusicVariants)
          .values({
            id,
            sequenceId: input.sequenceId,
            model: input.model,
            prompt: input.prompt,
            tags: input.tags,
            durationSeconds: input.durationSeconds,
            status: 'pending',
            isPrimary: false,
            workflowRunId: input.workflowRunId,
            createdAt: at,
            updatedAt: at,
          })
          .onConflictDoNothing();
        return id;
      }
      const casGuard: SQL | undefined =
        input.ifPendingIs === undefined
          ? undefined
          : input.ifPendingIs === null
            ? isNull(sequences.pendingPromoteMusicVariantId)
            : eq(sequences.pendingPromoteMusicVariantId, input.ifPendingIs);
      const bound = (value: string | number | null, name: string) =>
        sql`${value}`.as(name);
      // A retried step with the same id finds its row already open: the
      // pointer statement skips (it must not take back a claim a newer
      // kickoff moved since), the insert is a no-op, and the row answers.
      const [, , rows] = await db.batch([
        db
          .update(sequences)
          .set({ pendingPromoteMusicVariantId: id, updatedAt: at })
          .where(
            and(
              eq(sequences.id, input.sequenceId),
              casGuard,
              sql`not exists ${opened}`
            )
          ),
        db
          .insert(sequenceMusicVariants)
          .select(
            db
              .select({
                id: bound(id, 'id'),
                sequenceId: sequences.id,
                model: bound(input.model, 'model'),
                prompt: bound(input.prompt, 'prompt'),
                tags: bound(input.tags, 'tags'),
                durationSeconds: bound(
                  input.durationSeconds,
                  'duration_seconds'
                ),
                status: bound('pending', 'status'),
                isPrimary: bound(1, 'is_primary'),
                workflowRunId: bound(input.workflowRunId, 'workflow_run_id'),
                createdAt: bound(nowSeconds(), 'created_at'),
                updatedAt: bound(nowSeconds(), 'updated_at'),
              })
              .from(sequences)
              .where(
                and(
                  eq(sequences.id, input.sequenceId),
                  eq(sequences.pendingPromoteMusicVariantId, id)
                )
              )
          )
          .onConflictDoNothing(),
        opened,
      ]);
      return rows.length > 0 ? id : null;
    },

    /**
     * A run adopts the row its trigger opened: stamps its instance id and the
     * inputs it actually renders (a regeneration's prompt is only known once
     * its prompt child ran). Only while the row is still pending.
     */
    stampMusicRun: async (
      variantId: string,
      input: MusicRunInputs & { workflowRunId: string }
    ): Promise<void> => {
      await db
        .update(sequenceMusicVariants)
        .set({ ...input, updatedAt: new Date() })
        .where(
          and(
            eq(sequenceMusicVariants.id, variantId),
            eq(sequenceMusicVariants.status, 'pending')
          )
        );
    },

    /**
     * Land a track in place and consume the claim in one batch. The row is
     * parked (`divergedAt`) when it is primary and the claim no longer names
     * it — decided before the pointer statement, which moves the pointer only
     * while the claim still does. Replay-safe: a completed row and a consumed
     * claim make both statements no-ops. Returns the landed row.
     */
    completeMusicClaim: async (
      variantId: string,
      input: CompleteMusicClaimInput
    ): Promise<SequenceMusicVariant> => {
      const now = new Date();
      const claimMissed = sql`(select ${sequences.pendingPromoteMusicVariantId} from ${sequences} where ${sequences.id} = ${input.sequenceId}) is not ${variantId}`;
      await db.batch([
        db
          .update(sequenceMusicVariants)
          .set({
            status: 'completed',
            error: null,
            url: input.url,
            storagePath: input.storagePath,
            durationSeconds: input.durationSeconds,
            inputHash: input.inputHash,
            generatedAt: now,
            divergedAt: sql`CASE WHEN ${sequenceMusicVariants.isPrimary} = 1 AND ${claimMissed} THEN ${Math.floor(now.getTime() / 1000)} END`,
            updatedAt: now,
          })
          .where(
            and(
              eq(sequenceMusicVariants.id, variantId),
              sql`${sequenceMusicVariants.status} != 'completed'`
            )
          ),
        db
          .update(sequences)
          .set({
            selectedMusicVariantId: variantId,
            pendingPromoteMusicVariantId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(sequences.id, input.sequenceId),
              eq(sequences.pendingPromoteMusicVariantId, variantId)
            )
          ),
      ]);
      const landed = await getMusicById(variantId);
      if (!landed)
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      return landed;
    },

    /**
     * Fail a run's still-pending row and clear the claim only while it names
     * that row (rule 5). Matches by the trigger's row id and/or the run's
     * instance id. `recordIfMissing` appends a terminal failed row when no row
     * of this run exists at all.
     */
    failMusicClaim: async (
      input: FailMusicClaimInput,
      error: string
    ): Promise<void> => {
      const ofRun = or(
        input.variantId
          ? eq(sequenceMusicVariants.id, input.variantId)
          : undefined,
        input.workflowRunId
          ? eq(sequenceMusicVariants.workflowRunId, input.workflowRunId)
          : undefined
      );
      if (!ofRun) throw new Error('failMusicClaim needs a variantId or run id');
      const mine = and(
        eq(sequenceMusicVariants.sequenceId, input.sequenceId),
        ofRun
      );
      const now = new Date();
      await db.batch([
        db
          .update(sequences)
          .set({ pendingPromoteMusicVariantId: null, updatedAt: now })
          .where(
            and(
              eq(sequences.id, input.sequenceId),
              inArray(
                sequences.pendingPromoteMusicVariantId,
                db
                  .select({ id: sequenceMusicVariants.id })
                  .from(sequenceMusicVariants)
                  .where(and(mine, eq(sequenceMusicVariants.status, 'pending')))
              )
            )
          ),
        db
          .update(sequenceMusicVariants)
          .set({ status: 'failed', error, updatedAt: now })
          .where(and(mine, eq(sequenceMusicVariants.status, 'pending'))),
      ]);
      if (!input.recordIfMissing) return;
      const [existing] = await db
        .select({ id: sequenceMusicVariants.id })
        .from(sequenceMusicVariants)
        .where(mine)
        .limit(1);
      if (existing) return;
      await recordMusicFailure({
        sequenceId: input.sequenceId,
        model: input.recordIfMissing.model,
        error,
        workflowRunId: input.workflowRunId ?? null,
      });
    },

    recordMusicFailure,

    /**
     * The user's pick (Set Music, Promote): point the sequence at a finished
     * track, un-park it, clear any claim — a run still in flight then finds
     * its claim gone and lands parked (rule 4) — and retire failed primary
     * runs from the status, so the sequence reads completed.
     */
    selectMusic: async (
      sequenceId: string,
      variantId: string
    ): Promise<Sequence> => {
      const variant = await getMusicById(variantId);
      if (!variant || variant.sequenceId !== sequenceId) {
        throw new NotFoundError(`SequenceMusicVariant ${variantId} not found`);
      }
      if (variant.status !== 'completed' || !variant.url) {
        throw new ValidationError(
          `SequenceMusicVariant ${variantId} is '${variant.status}' with no track — cannot select`
        );
      }
      const now = new Date();
      await db.batch([
        db
          .update(sequences)
          .set({
            selectedMusicVariantId: variantId,
            pendingPromoteMusicVariantId: null,
            updatedAt: now,
          })
          .where(eq(sequences.id, sequenceId)),
        db
          .update(sequenceMusicVariants)
          .set({ divergedAt: null, updatedAt: now })
          .where(eq(sequenceMusicVariants.id, variantId)),
        // A failure the user answered by picking a track no longer speaks
        // for the sequence: its failed runs leave the status race, so the
        // music reads completed (as the old copy-onto-the-sequence did) and
        // smart retry does not pay for a new track. The rows stay history.
        db
          .update(sequenceMusicVariants)
          .set({ isPrimary: false, updatedAt: now })
          .where(
            and(
              eq(sequenceMusicVariants.sequenceId, sequenceId),
              eq(sequenceMusicVariants.isPrimary, true),
              eq(sequenceMusicVariants.status, 'failed')
            )
          ),
      ]);
      return readSequence(sequenceId);
    },

    /**
     * An uploaded score (#1108): a completed primary row, selected, with any
     * claim cleared — one batch. The earlier uploads are parked
     * (`divergedAt`), so the alternates banner still offers them back —
     * Set Music only reaches a model's newest track. `inputHash` is null: the
     * user chose this exact track, so no prompt edit reads it stale.
     */
    appendUploadedMusic: async (input: {
      sequenceId: string;
      model: string;
      url: string;
      storagePath: string;
      prompt: string | null;
      tags: string | null;
      durationSeconds: number | null;
    }): Promise<SequenceMusicVariant> => {
      const id = generateId();
      const now = new Date();
      const [, rows] = await db.batch([
        db
          .update(sequenceMusicVariants)
          .set({ divergedAt: now, updatedAt: now })
          .where(
            and(
              eq(sequenceMusicVariants.sequenceId, input.sequenceId),
              eq(sequenceMusicVariants.model, input.model),
              eq(sequenceMusicVariants.status, 'completed'),
              isNull(sequenceMusicVariants.divergedAt)
            )
          ),
        db
          .insert(sequenceMusicVariants)
          .values({
            ...input,
            id,
            status: 'completed',
            isPrimary: true,
            generatedAt: now,
            inputHash: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
        db
          .update(sequences)
          .set({
            selectedMusicVariantId: id,
            pendingPromoteMusicVariantId: null,
            updatedAt: now,
          })
          .where(eq(sequences.id, input.sequenceId)),
      ]);
      const variant = rows[0];
      if (!variant) throw new Error('appendUploadedMusic returned no row');
      return variant;
    },

    // ── Divergent (parked) tracks ─────────────────────────────────────────
    /**
     * Aggregate parked-track counts across a team's sequences. Powers the
     * corner-dot indicator on the sequence dashboard — a single round-trip
     * keyed by `teamId` instead of N per-sequence calls.
     */
    listDivergentByTeam: async (
      teamId: string
    ): Promise<Array<{ sequenceId: string; hasMusic: boolean }>> => {
      const musicRows = await db
        .select({ sequenceId: sequenceMusicVariants.sequenceId })
        .from(sequenceMusicVariants)
        .innerJoin(
          sequences,
          eq(sequences.id, sequenceMusicVariants.sequenceId)
        )
        .where(
          and(
            eq(sequences.teamId, teamId),
            sql`${sequenceMusicVariants.divergedAt} IS NOT NULL`,
            sql`${sequenceMusicVariants.discardedAt} IS NULL`
          )
        );

      const byId = new Map<string, { sequenceId: string; hasMusic: boolean }>();
      for (const { sequenceId } of musicRows) {
        if (!byId.has(sequenceId)) {
          byId.set(sequenceId, { sequenceId, hasMusic: true });
        }
      }
      return [...byId.values()];
    },

    listDivergentMusic: async (
      sequenceId: string
    ): Promise<SequenceMusicVariant[]> => {
      return db
        .select()
        .from(sequenceMusicVariants)
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, sequenceId),
            sql`${sequenceMusicVariants.divergedAt} IS NOT NULL`,
            sql`${sequenceMusicVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(sequenceMusicVariants.divergedAt);
    },

    discardMusicVariant: async (variantId: string): Promise<Date> => {
      const discardedAt = new Date();
      const result = await db
        .update(sequenceMusicVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(sequenceMusicVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    undiscardMusicVariant: async (variantId: string): Promise<void> => {
      const result = await db
        .update(sequenceMusicVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(sequenceMusicVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      }
    },
  };
}
