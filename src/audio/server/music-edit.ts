/**
 * Sequence music edits shared by the editor's server fns and the MCP tools
 * (#1979): save or restore the music prompt, pick a track, discard / undiscard
 * one, generate a track, rewrite the prompt with the LLM.
 */
import { NotFoundError, ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import {
  DEFAULT_MUSIC_MODEL,
  isValidAudioModel,
  safeAudioModel,
} from '@/models/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import {
  computeMusicPromptInputHash,
  musicPromptInputHashMatches,
} from '@/shots/input-hash';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type {
  MusicPromptWorkflowInput,
  MusicWorkflowInput,
} from '@/platform/server/workflow/types';
import { musicRequestDurationSeconds } from '@/audio/server/music-staleness';
import { musicSceneSummariesFromRows } from '@/audio/server/workflows/music-scene-summaries';

const logger = getLogger(['openstory', 'audio', 'music-edit']);

type Actor = { userId: string };

/**
 * Shape needed to decide whether a variant is promotable. Music variant rows
 * satisfy this — the precondition checks are: cross-sequence, live-ness,
 * asset-presence.
 */
export type SequenceVariantPromoteCandidate = {
  id: string;
  sequenceId: string;
  divergedAt: Date | null;
  discardedAt: Date | null;
  url: string | null;
};

/** Throw if `variant` is not a promotable live divergent alternate of `sequenceId`. */
export function assertSequenceVariantPromotable<
  T extends SequenceVariantPromoteCandidate,
>(variant: T | null, sequenceId: string): asserts variant is T {
  if (!variant || variant.sequenceId !== sequenceId) {
    throw new NotFoundError('Variant not found for this sequence');
  }
  if (variant.divergedAt === null || variant.discardedAt !== null) {
    throw new ValidationError('Variant is not a live divergent alternate');
  }
  if (!variant.url) {
    throw new ValidationError('Variant has no asset to promote');
  }
}

/** A music track of this sequence. */
async function requireMusicTrack(
  scopedDb: ScopedDb,
  sequenceId: string,
  variantId: string
) {
  const variant = await scopedDb.sequenceVariants.getMusicById(variantId);
  if (!variant || variant.sequenceId !== sequenceId) {
    throw new NotFoundError('Variant not found for this sequence');
  }
  return variant;
}

/**
 * Point the sequence at one of its finished tracks and un-park it (#1115),
 * then emit a terminal `audio:progress` so listeners refetch the sequence.
 * Promote (a parked alternate) and Set Music (a model's newest track) both
 * land here; a discarded track must be restored first.
 */
export async function selectMusicTrack(
  scopedDb: ScopedDb,
  sequenceId: string,
  variantId: string
) {
  const variant = await requireMusicTrack(scopedDb, sequenceId, variantId);
  if (variant.discardedAt) {
    throw new ValidationError('This track is discarded; restore it first.');
  }
  const sequence = await scopedDb.sequenceVariants.selectMusic(
    sequenceId,
    variant.id
  );
  try {
    await getGenerationChannel(sequenceId).emit('generation.audio:progress', {
      status: 'completed',
      model: variant.model,
      ...(sequence.musicUrl ? { audioUrl: sequence.musicUrl } : {}),
    });
  } catch (error) {
    logger.error('realtime emit failed', { err: error });
  }
  return { sequence, variant };
}

export async function discardMusicTrack(
  scopedDb: ScopedDb,
  sequenceId: string,
  variantId: string
) {
  const variant = await requireMusicTrack(scopedDb, sequenceId, variantId);
  const discardedAt = await scopedDb.sequenceVariants.discardMusicVariant(
    variant.id
  );
  return { variantId: variant.id, discardedAt };
}

export async function undiscardMusicTrack(
  scopedDb: ScopedDb,
  sequenceId: string,
  variantId: string
) {
  const variant = await requireMusicTrack(scopedDb, sequenceId, variantId);
  await scopedDb.sequenceVariants.undiscardMusicVariant(variant.id);
  return { variantId: variant.id };
}

/**
 * Persist a hand-edited music prompt WITHOUT regenerating the track (#1108
 * Phase 4). Appends a selected `user-edit` version; a user edit carries no
 * upstream hash, so music-prompt staleness reads 'untracked' until the next AI
 * regeneration. Omitted tags keep the current ones.
 */
export async function saveMusicPrompt(
  scopedDb: ScopedDb,
  actor: Actor,
  sequence: Sequence,
  input: { prompt: string; tags?: string }
) {
  const nextTags = input.tags ?? sequence.musicTags ?? null;
  if (
    input.prompt === (sequence.musicPrompt ?? '') &&
    nextTags === (sequence.musicTags ?? null)
  ) {
    return { unchanged: true } as const;
  }
  const version = await scopedDb.sequenceMusicPromptVersions.write({
    sequenceId: sequence.id,
    prompt: input.prompt,
    tags: nextTags,
    source: 'user-edit',
    createdBy: actor.userId,
  });
  await scopedDb.sequenceEvents.record({
    sequenceId: sequence.id,
    actorId: actor.userId,
    kind: 'music-prompt.edited',
    targetType: 'sequence',
    targetId: sequence.id,
    summary: 'Edited music prompt',
    data: {
      versionId: version.id,
      prevState: {
        prompt: sequence.musicPrompt ?? null,
        tags: sequence.musicTags ?? null,
      },
    },
  });
  return { unchanged: false, versionId: version.id } as const;
}

/**
 * Make an earlier music prompt version current: a new selected `restored`
 * version with its text. The source's input hash rides along so staleness
 * keeps tracking the upstream context.
 */
export async function restoreMusicPromptVersion(
  scopedDb: ScopedDb,
  actor: Actor,
  sequenceId: string,
  versionId: string
) {
  const chosen = await scopedDb.sequenceMusicPromptVersions.getByIdForSequence(
    versionId,
    sequenceId
  );
  if (!chosen) {
    throw new NotFoundError('Music prompt variant not found for this sequence');
  }
  const inserted = await scopedDb.sequenceMusicPromptVersions.write({
    sequenceId,
    prompt: chosen.prompt,
    tags: chosen.tags,
    source: 'restored',
    inputHash: chosen.inputHash,
    analysisModel: chosen.analysisModel,
    createdBy: actor.userId,
  });
  return { variantId: inserted.id };
}

/**
 * Generate the sequence's music track (`generateMusicFn`). Uses the given
 * prompt/tags, else the stored ones; an edited prompt or tags is recorded as
 * a `user-edit` version first. The row and claim are taken before the run
 * (#1130), compare-and-swapped on the claim this request saw: of two rapid
 * calls the second finds the claim moved and starts nothing.
 */
export async function generateMusic(
  scopedDb: ScopedDb,
  actor: Actor,
  sequence: Sequence,
  data: { prompt?: string; tags?: string; model?: string; duration?: number }
): Promise<{ success: true; variantId: string | null }> {
  const effectivePrompt = data.prompt ?? sequence.musicPrompt;
  const effectiveTags = data.tags ?? sequence.musicTags;

  if (!effectivePrompt) {
    throw new ValidationError(
      'Music prompt has not been generated yet — generate the storyboard first before editing music inputs.'
    );
  }
  if (!effectiveTags) {
    throw new ValidationError('Music tags are required.');
  }

  // Persist the user's intent before triggering the workflow. Both
  // `data.prompt` and `data.tags` are surfaced as a single user-edit
  // revision, which the versions helper selects, so a tags-only edit isn't
  // dropped.
  if (data.prompt !== undefined || data.tags !== undefined) {
    await scopedDb.sequenceMusicPromptVersions.write({
      sequenceId: sequence.id,
      prompt: effectivePrompt,
      tags: effectiveTags,
      source: 'user-edit',
      createdBy: actor.userId,
    });
  }

  const allShots = await scopedDb.shots.listBySequence(sequence.id);
  const totalDuration = musicRequestDurationSeconds(allShots);

  const baseInput = {
    userId: actor.userId,
    teamId: sequence.teamId,
    sequenceId: sequence.id,
    duration: data.duration ?? totalDuration,
    model: data.model && isValidAudioModel(data.model) ? data.model : undefined,
  };

  const musicInput: MusicWorkflowInput = {
    ...baseInput,
    prompt: effectivePrompt,
    tags: effectiveTags,
  };

  const variantId = await scopedDb.sequenceVariants.claimMusic({
    sequenceId: sequence.id,
    model: baseInput.model ?? DEFAULT_MUSIC_MODEL,
    prompt: effectivePrompt,
    tags: effectiveTags,
    durationSeconds: baseInput.duration,
    isPrimary: true,
    workflowRunId: null,
    ifPendingIs: sequence.pendingPromoteMusicVariantId,
  });
  if (!variantId) return { success: true, variantId: null };

  try {
    await triggerWorkflow('/music', { ...musicInput, variantId });
  } catch (error) {
    await scopedDb.sequenceVariants.failMusicClaim(
      { sequenceId: sequence.id, variantId },
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }

  return { success: true, variantId };
}

/** Stable deduplication ID for music-prompt regeneration. */
export function musicPromptDedupId(
  sequenceId: string,
  liveHash: string
): string {
  return `music-prompt-${sequenceId}-${liveHash}`;
}

/**
 * Rewrite the music prompt from the scenes with the analysis LLM
 * (`regenerateMusicPromptFn`). No-ops when nothing changed since the cached
 * hash was written, so a double click never enqueues a duplicate run.
 */
export async function rewriteMusicPrompt(
  scopedDb: ScopedDb,
  actor: Actor,
  sequence: Sequence
) {
  const [shots, sceneRows] = await Promise.all([
    scopedDb.shots.listBySequence(sequence.id),
    scopedDb.scenes.listBySequence(sequence.id),
  ]);
  const { sceneSummaries, legacyShotSummaries } = musicSceneSummariesFromRows(
    sceneRows,
    shots
  );
  if (sceneSummaries.length === 0) {
    throw new ValidationError(
      'Sequence has no scenes to regenerate the music prompt from'
    );
  }

  const analysisModelId =
    getAnalysisModelById(sequence.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL;

  const liveHash = await computeMusicPromptInputHash({
    sceneSummaries,
    analysisModel: analysisModelId,
  });
  if (
    await musicPromptInputHashMatches(
      sequence.musicPromptInputHash,
      { sceneSummaries, analysisModel: analysisModelId },
      legacyShotSummaries
    )
  ) {
    return { workflowRunId: null, alreadyUpToDate: true } as const;
  }

  const workflowRunId = await triggerWorkflow<MusicPromptWorkflowInput>(
    '/music-prompt',
    {
      userId: actor.userId,
      teamId: scopedDb.teamId,
      sequenceId: sequence.id,
      sceneSummaries,
      analysisModelId,
      // Provenance snapshotted here: a prompt already on the sequence makes
      // this a regeneration.
      promptSource: sequence.musicPrompt ? 'regenerated' : 'ai-generated',
      musicModel: safeAudioModel(sequence.musicModel),
    },
    {
      // Dedup by the live input hash so a retry of the same upstream context
      // collapses to one workflow run instead of N.
      deduplicationId: musicPromptDedupId(sequence.id, liveHash),
    }
  );

  return { workflowRunId, alreadyUpToDate: false } as const;
}
