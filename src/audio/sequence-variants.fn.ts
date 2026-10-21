/**
 * Server functions for sequence-level music variants:
 *   - `getDivergentSequenceMusicVariantsFn` reads the live divergent alternates.
 *   - `promoteSequenceMusicVariantFn` points the sequence at a parked track
 *     and un-parks it (#1115), then emits a synthetic terminal realtime event
 *     so existing listeners refetch the sequence.
 *   - `discardSequenceMusicVariantFn` / `undiscardSequenceMusicVariantFn` toggle
 *     `discardedAt` for the toast Undo flow.
 * The writes live in `@/audio/server/music-edit`, shared with MCP.
 */

import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  authWithTeamMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';
import { NotFoundError } from '@/platform/errors';
import {
  discardMusicTrack,
  selectMusicTrack,
  undiscardMusicTrack,
} from '@/audio/server/music-edit';

const variantInputSchema = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

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
    const selected = await selectMusicTrack(
      context.scopedDb,
      context.sequence.id,
      data.variantId
    );
    return { sequence: selected.sequence, variantId: selected.variant.id };
  });

// ── Set music model (non-destructive) ────────────────────────────────────────

const setMusicFromVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  model: z.string().min(1),
});

/**
 * Switch the sequence's music to the selected model's track ("Set Music").
 * Resolves the model to its newest finished (non-parked, non-discarded) track
 * and points the sequence at it (#1115); the other models' tracks stay to
 * switch back to.
 */
export const setMusicFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setMusicFromVariantInputSchema))
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb } = context;
    const variants = await scopedDb.sequenceVariants.listMusicBySequence(
      sequence.id
    );
    const variant = [...variants]
      .reverse()
      .find(
        (v) =>
          v.model === data.model &&
          v.status === 'completed' &&
          v.divergedAt === null &&
          v.discardedAt === null &&
          v.url
      );
    if (!variant) {
      throw new NotFoundError('No completed track found for this model');
    }
    const selected = await selectMusicTrack(scopedDb, sequence.id, variant.id);
    return { sequence: selected.sequence, model: variant.model };
  });

// ── Discard / Undiscard ─────────────────────────────────────────────────────

export const discardSequenceMusicVariantFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(
    async ({ data, context }) =>
      await discardMusicTrack(
        context.scopedDb,
        context.sequence.id,
        data.variantId
      )
  );

export const undiscardSequenceMusicVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(variantInputSchema))
  .handler(
    async ({ data, context }) =>
      await undiscardMusicTrack(
        context.scopedDb,
        context.sequence.id,
        data.variantId
      )
  );
