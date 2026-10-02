/**
 * Sequence music edits shared by the editor's server fns and the MCP tools
 * (#1979): save or restore the music prompt, pick a track, discard / undiscard
 * one. No generation starts here.
 */
import { NotFoundError, ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';

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
