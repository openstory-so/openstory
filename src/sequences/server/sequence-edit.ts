/**
 * Sequence-level edits shared by the editor's server fns and the MCP tools,
 * so both write the same rows, events and side effects.
 */
import type { z } from 'zod';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/models/models';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { estimateStoryboardPreflightCost } from '@/billing/storyboard-preflight-cost';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { bumpStylePopularity } from '@/look/server/bump-style-popularity';
import { releaseCharacterVoice } from '@/cast/server/voice/release-voice';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { triggerStoryboard } from '@/sequences/server/launchers';
import type { updateSequenceSchema } from '@/sequences/server/sequence.schemas';
import {
  allowsUnfundedGeneration,
  flagsFromStopAt,
  resolveStopAt,
} from '@/sequences/pipeline';

type Actor = { userId: string; teamId: string };

export type SequenceUpdate = z.infer<typeof updateSequenceSchema>;

/** Fields whose change re-runs the whole storyboard. */
function updateNeedsStoryboard(update: SequenceUpdate): boolean {
  return (
    update.script !== undefined ||
    update.styleId !== undefined ||
    update.aspectRatio !== undefined ||
    update.analysisModel !== undefined
  );
}

/**
 * Write a sequence update; a script, style, aspect ratio or analysis model
 * change re-runs the storyboard (credits reserved first, unless the stop-at
 * runs unfunded). Only the fields present are written.
 */
export async function updateSequence(
  scopedDb: ScopedDb,
  actor: Actor,
  previous: Sequence,
  update: SequenceUpdate
): Promise<Sequence> {
  const sequenceId = previous.id;
  // No eager 'processing' write: `triggerStoryboard` owns the status flip
  // below, so a rejected trigger (mutex held, no script) leaves the sequence
  // in its real state instead of a spinner that never resolves.
  const sequence = await scopedDb.sequences.update({
    id: sequenceId,
    ...update,
  });

  // sequences.styleId is `.notNull() + onDelete: 'set null'` — TS types it as
  // non-null but the runtime value can be null after the parent style is
  // deleted. Keep the runtime guard despite what the type says.
  if (
    update.styleId !== undefined &&
    update.styleId !== previous.styleId &&
    sequence.styleId
  ) {
    bumpStylePopularity({
      scopedDb,
      styleId: sequence.styleId,
      sequenceIds: [sequence.id],
      teamId: actor.teamId,
      userId: actor.userId,
    });
  }

  if (!updateNeedsStoryboard(update)) return sequence;

  const stopAt = resolveStopAt({
    generationStopAt: sequence.generationStopAt,
  });
  const reservationId = allowsUnfundedGeneration(stopAt)
    ? undefined
    : await reserveRunCredits(
        scopedDb,
        estimateStoryboardPreflightCost({
          script: sequence.script ?? '',
          imageModel: safeTextToImageModel(
            sequence.imageModel,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
          resolution: sequence.resolution,
          stopAt,
          videoModels: [
            safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
          ],
          audioModels: [
            safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL),
          ],
          referenceOnly: !sequence.generateStartFrames,
          generateVoices: sequence.generateVoices,
          draftMotion: sequence.draftMotion,
          targetDurationSeconds: sequence.targetDurationSeconds ?? undefined,
          pricing: await getEffectiveFalPricing(),
        }),
        {
          providers: ['fal', 'openrouter'],
          errorMessage: 'Insufficient credits to regenerate storyboard',
          sequenceId,
        }
      );

  // Owns the generation mutex, the 'processing' status write, the run-id
  // persistence (#839), and the trigger-time content snapshot. Regeneration
  // used to trigger `/storyboard` raw, so it both bypassed the mutex and
  // left the workflow to re-derive the payload mid-run.
  await releaseReservationOnThrow(scopedDb, reservationId, () =>
    triggerStoryboard(scopedDb, {
      userId: actor.userId,
      teamId: actor.teamId,
      sequenceId,
      reservationId,
      options: {
        shotsPerScene: 3,
        generateThumbnails: true,
        generateDescriptions: true,
        aiProvider: 'openrouter',
        regenerateAll: true,
      },
      ...flagsFromStopAt(stopAt),
      stopAt,
    })
  );
  return sequence;
}

/** Rename, recording the event only when the title changed. */
export async function renameSequence(
  scopedDb: ScopedDb,
  actor: { userId: string },
  previous: Sequence,
  title: string
): Promise<Sequence> {
  const sequence = await scopedDb.sequences.update({
    id: previous.id,
    title,
  });
  if (title !== previous.title) {
    await scopedDb.sequenceEvents.record({
      sequenceId: previous.id,
      actorId: actor.userId,
      kind: 'sequence.renamed',
      targetType: 'sequence',
      targetId: previous.id,
      summary: `Renamed sequence to ${title}`,
      data: { prevTitle: previous.title },
    });
  }
  return sequence;
}

/**
 * Archive (the product's delete): hides the sequence, lets in-flight
 * workflows finish, and records the prior status for {@link unarchiveSequence}.
 */
export async function archiveSequence(
  scopedDb: ScopedDb,
  actor: { userId: string },
  sequence: Sequence
): Promise<void> {
  const prevStatus = sequence.status;
  if (prevStatus === 'archived') return;
  // Archive frees the cast's voice slots (#1553). Descriptions and previews
  // stay, so an unarchive can regenerate. Runs BEFORE the status flip: a
  // failed release throws past it, the sequence stays live, and the next
  // attempt retries the rows still holding an id.
  // Known gap: a voice child still running lands its id after this loop;
  // that slot is only freed by a later soft-delete or regenerate.
  for (const character of await scopedDb.characters.list(sequence.id)) {
    await releaseCharacterVoice(scopedDb, character, actor.userId);
  }
  await scopedDb.sequence(sequence.id).updateStatus('archived');
  await scopedDb.sequenceEvents.record({
    sequenceId: sequence.id,
    actorId: actor.userId,
    kind: 'sequence.archived',
    targetType: 'sequence',
    targetId: sequence.id,
    summary: `Archived ${sequence.title}`,
    data: { prevState: { status: prevStatus } },
  });
}

/**
 * Statuses an unarchive may restore verbatim. `'processing'` is deliberately
 * NOT here: archiving lets the in-flight run finish, so by unarchive time the
 * generation is over one way or the other, and re-asserting 'processing'
 * makes the editor poll and show "Generating…" for a run that is not
 * happening. The cron reconciler only heals such a row while its Cloudflare
 * instance is still resolvable, so a long-archived sequence would stay stuck.
 * A recorded 'processing' maps to {@link INTERRUPTED_ERROR} instead — the
 * same honest, retryable state the reconciler writes for a dead run.
 */
const RESTORABLE_STATUSES = ['draft', 'completed', 'failed'] as const;
type RestorableStatus = (typeof RESTORABLE_STATUSES)[number];
function isRestorableStatus(value: string | null): value is RestorableStatus {
  return (
    value !== null && (RESTORABLE_STATUSES as readonly string[]).includes(value)
  );
}

/** Maps a recorded archive prevStatus to the status unarchive should restore. */
export function resolveUnarchiveRestore(args: {
  recordedStatus: string | null;
  hasShots: boolean;
}): { status: RestorableStatus; interrupted: boolean } {
  if (args.recordedStatus === 'processing') {
    return { status: 'failed', interrupted: true };
  }
  if (isRestorableStatus(args.recordedStatus)) {
    return { status: args.recordedStatus, interrupted: false };
  }
  return {
    status: args.hasShots ? 'completed' : 'draft',
    interrupted: false,
  };
}

/** Mirrors `reconcileSequencesPass`'s wording for an interrupted run. */
const INTERRUPTED_ERROR =
  'Generation was interrupted — use Retry to run it again.';

/**
 * Undo an archive (#1108 Phase 4): restore the status the sequence had when
 * it was archived (from the `sequence.archived` event's prevState). Sequences
 * archived before that event existed fall back to a content-derived status —
 * 'completed' when the sequence has shots, else 'draft'.
 */
export async function unarchiveSequence(
  scopedDb: ScopedDb,
  actor: { userId: string },
  sequence: Sequence
): Promise<Sequence['status']> {
  if (sequence.status !== 'archived') return sequence.status;
  const events = await scopedDb.sequenceEvents.listByTarget(
    'sequence',
    sequence.id
  );
  const archiveEvent = events.find((e) => e.kind === 'sequence.archived');
  const recorded = archiveEvent?.data?.prevState;
  const recordedStatus =
    recorded !== null &&
    recorded !== undefined &&
    typeof recorded === 'object' &&
    !Array.isArray(recorded) &&
    typeof recorded.status === 'string'
      ? recorded.status
      : null;
  // A run that was mid-flight at archive time is over by now — restore the
  // interrupted state rather than a "Generating…" the user can't act on.
  const hasShots =
    (await scopedDb.shots.listBySequence(sequence.id, { limit: 1 })).length > 0;
  const { status, interrupted } = resolveUnarchiveRestore({
    recordedStatus,
    hasShots,
  });

  await scopedDb
    .sequence(sequence.id)
    .updateStatus(status, interrupted ? INTERRUPTED_ERROR : null);
  await scopedDb.sequenceEvents.record({
    sequenceId: sequence.id,
    actorId: actor.userId,
    kind: 'sequence.unarchived',
    targetType: 'sequence',
    targetId: sequence.id,
    summary: `Unarchived ${sequence.title}`,
    data: { restoredStatus: status },
  });
  return status;
}
