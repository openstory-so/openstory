/**
 * Server functions for sequence-level music variants:
 *   - `getDivergentSequenceMusicVariantsFn` reads the live divergent alternates.
 *   - `promoteSequenceMusicVariantFn` atomically copies variant fields onto
 *     `sequences.*` and soft-deletes the variant row, then emits a synthetic
 *     terminal realtime event so existing listeners refetch the sequence.
 *   - `discardSequenceMusicVariantFn` / `undiscardSequenceMusicVariantFn` toggle
 *     `discardedAt` for the toast Undo flow.
 */

import { ulidSchema } from '@/lib/schemas/id.schemas';
import { getGenerationChannel } from '@/lib/realtime';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'sequence-variants']);

const variantInputSchema = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

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

/**
 * Throw if `variant` is not a promotable live divergent alternate of
 * `sequenceId`. Extracted so the precondition logic is unit-testable
 * independent of the server-fn harness.
 */
export function assertSequenceVariantPromotable<
  T extends SequenceVariantPromoteCandidate,
>(variant: T | null, sequenceId: string): asserts variant is T {
  if (!variant || variant.sequenceId !== sequenceId) {
    throw new Error('Variant not found for this sequence');
  }
  if (variant.divergedAt === null || variant.discardedAt !== null) {
    throw new Error('Variant is not a live divergent alternate');
  }
  if (!variant.url) {
    throw new Error('Variant has no asset to promote');
  }
}

// ── Read: divergent alternates ──────────────────────────────────────────────

export const getDivergentSequenceMusicVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceVariants.listDivergentMusic(
      context.sequence.id
    );
  });

/**
 * Aggregate read for the team's sequences-list dashboard. Returns one row per
 * sequence that has at least one live divergent music alternate.
 */
export const getTeamDivergentSequenceVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceVariants.listDivergentByTeam(
      context.teamId
    );
  });

// ── Promote: music ──────────────────────────────────────────────────────────

export const promoteSequenceMusicVariantFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb } = context;
    const variant = await scopedDb.sequenceVariants.getMusicById(
      data.variantId
    );
    assertSequenceVariantPromotable(variant, sequence.id);

    const { sequence: updatedSequence } =
      await scopedDb.sequenceVariants.promoteMusicVariant(variant.id);

    try {
      await getGenerationChannel(sequence.id).emit(
        'generation.audio:progress',
        {
          status: 'completed',
          model: variant.model,
          ...(updatedSequence.musicUrl
            ? { audioUrl: updatedSequence.musicUrl }
            : {}),
        }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { sequence: updatedSequence, variantId: variant.id };
  });

// ── Set music model (non-destructive) ────────────────────────────────────────

const setMusicFromVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  model: z.string().min(1),
});

/**
 * Switch the sequence's live primary music to the selected model's track
 * ("Set Music"), the per-sequence analog of `setVideoFromVariantFn`. Resolves
 * the model to its own live (non-divergent, non-discarded) completed variant
 * and copies it onto `sequences.music*` without discarding the row, so the
 * model stays available to switch back to. Emits a terminal `audio:progress`
 * so existing listeners refetch the sequence.
 */
export const setMusicFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setMusicFromVariantInputSchema))
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb } = context;
    const variants = await scopedDb.sequenceVariants.listMusicBySequence(
      sequence.id
    );
    const variant = variants.find(
      (v) =>
        v.model === data.model &&
        v.status === 'completed' &&
        v.divergedAt === null &&
        v.discardedAt === null &&
        v.url
    );
    if (!variant) {
      throw new Error('No completed track found for this model');
    }

    const updatedSequence = await scopedDb.sequenceVariants.setMusicFromVariant(
      variant.id
    );

    try {
      await getGenerationChannel(sequence.id).emit(
        'generation.audio:progress',
        {
          status: 'completed',
          model: variant.model,
          ...(updatedSequence.musicUrl
            ? { audioUrl: updatedSequence.musicUrl }
            : {}),
        }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { sequence: updatedSequence, model: variant.model };
  });

// ── Discard / Undiscard ─────────────────────────────────────────────────────

export const discardSequenceMusicVariantFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.sequenceVariants.getMusicById(
      data.variantId
    );
    if (!variant || variant.sequenceId !== context.sequence.id) {
      throw new Error('Variant not found for this sequence');
    }
    const discardedAt =
      await context.scopedDb.sequenceVariants.discardMusicVariant(variant.id);
    return { variantId: variant.id, discardedAt };
  });

export const undiscardSequenceMusicVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.sequenceVariants.getMusicById(
      data.variantId
    );
    if (!variant || variant.sequenceId !== context.sequence.id) {
      throw new Error('Variant not found for this sequence');
    }
    await context.scopedDb.sequenceVariants.undiscardMusicVariant(variant.id);
    return { variantId: variant.id };
  });
