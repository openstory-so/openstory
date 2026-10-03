/**
 * Sequence-level edits shared by the editor's server fns and the MCP tools,
 * so both write the same rows, events and side effects.
 */
import type { AspectRatio } from '@/models/aspect-ratios';
import {
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/models/models';
import { releaseCharacterVoice } from '@/cast/server/voice/release-voice';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import {
  createSequenceSchema,
  type CreateSequenceInput,
} from '@/sequences/server/sequence.schemas';
import { resolveStopAt } from '@/sequences/pipeline';

/** What a regenerate may change; everything else comes from the source. */
type StoryboardChange = {
  script?: string;
  styleId?: string;
  aspectRatio?: AspectRatio;
  analysisModel?: string;
};

/**
 * The create input for a regenerate, built the way the editor's Generate
 * builds it (`script-view.tsx`): the source sequence's settings with the
 * change applied, and `sourceSequenceId` so its elements are copied. A
 * regenerate is a NEW sequence; the source is left as it is.
 */
export function regenerateInput(
  source: Sequence,
  change: StoryboardChange
): CreateSequenceInput {
  const videoModel = safeImageToVideoModel(source.videoModel);
  const musicModel = safeAudioModel(source.musicModel);
  return createSequenceSchema.parse({
    script: change.script ?? source.script,
    styleId: change.styleId ?? source.styleId,
    aspectRatio: change.aspectRatio ?? source.aspectRatio,
    resolution: source.resolution,
    analysisModels: [change.analysisModel ?? source.analysisModel],
    imageModels: [safeTextToImageModel(source.imageModel)],
    videoModel,
    videoModels: [videoModel],
    stopAt: resolveStopAt({ generationStopAt: source.generationStopAt }),
    generateStartFrames: source.generateStartFrames,
    generateVoices: source.generateVoices,
    draftMotion: source.draftMotion,
    musicModel,
    audioModels: [musicModel],
    targetDurationSeconds: source.targetDurationSeconds ?? undefined,
    sourceSequenceId: source.id,
  });
}

/**
 * Settings write, one UPDATE; a changed title also records
 * `sequence.renamed`. Only the fields present are written.
 */
export async function updateSequenceSettings(
  scopedDb: ScopedDb,
  actor: { userId: string },
  previous: Sequence,
  settings: {
    title?: string;
    targetDurationSeconds?: number | null;
    includeMusic?: boolean;
    videoModel?: string;
  }
): Promise<Sequence> {
  const sequence = await scopedDb.sequences.update({
    id: previous.id,
    ...settings,
  });
  if (settings.title !== undefined && settings.title !== previous.title) {
    await scopedDb.sequenceEvents.record({
      sequenceId: previous.id,
      actorId: actor.userId,
      kind: 'sequence.renamed',
      targetType: 'sequence',
      targetId: previous.id,
      summary: `Renamed sequence to ${settings.title}`,
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
