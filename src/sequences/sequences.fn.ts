import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidImageToVideoModel,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/models/models';
import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { generateMusic } from '@/audio/server/music-edit';
import {
  releaseReservationOnThrow,
  requireCredits,
  reserveRunCredits,
} from '@/billing/server/preflight';
import { estimateStoryboardPreflightCost } from '@/billing/storyboard-preflight-cost';
import { DEFAULT_ASPECT_RATIO } from '@/models/aspect-ratios';
import { VARIANT_TYPES } from '@/platform/server/db/schema/shot-variants';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  createSequenceSchema,
  updateSequenceSchema,
} from '@/sequences/server/sequence.schemas';
import {
  getSequenceRejectingActiveRun,
  triggerContinue,
  triggerStoryboard,
} from '@/sequences/server/launchers';
import { computePlan } from '@/shots/server/update-stale-plan';
import {
  allowsUnfundedGeneration,
  flagsFromStopAt,
  generationStageSchema,
  resolveStopAt,
} from './pipeline';
import { planWork } from './generation-plan';
import { computeGenerationPlan } from '@/sequences/server/generation-plan';
import {
  continueFromPlan,
  estimateContinueCost,
} from '@/sequences/server/continue-plan';
import { switchStopAt } from '@/sequences/generation-plan';
import type { StoryboardTriggerInput } from '@/platform/server/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  authWithTeamMiddleware,
  sequenceAccessMiddleware,
} from '@/platform/middleware.fn';
import {
  addModelToSequence,
  setSequenceModel,
} from '@/sequences/server/sequence-models';
import { createSequences } from '@/sequences/server/create-sequences';
import {
  archiveSequence,
  renameSequence,
  unarchiveSequence,
  updateSequence,
} from '@/sequences/server/sequence-edit';

export const getSequencesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequences.list();
  });

/** Archived sequences for the unarchive picker (#1108 Phase 4) — the default
 * list excludes them. */
export const getArchivedSequencesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequences.listArchived();
  });

export const getSequenceFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return context.sequence;
  });

const continueFlagsSchema = z.object({
  sequenceId: ulidSchema,
  stopAt: generationStageSchema,
  generateStartFrames: z.boolean(),
  generateVoices: z.boolean(),
  /** Draft first (#1756). */
  draftMotion: z.boolean(),
});

/**
 * The continue footer's quote (#1817): the generation plan under the footer's
 * switches, filtered to work up to the stop, priced per unit — the same
 * number `continueGenerationFn` reserves.
 */
export const estimateGenerationSliceFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(continueFlagsSchema))
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb } = context;
    const [plan, shots] = await Promise.all([
      computeGenerationPlan(scopedDb, sequence.id, {
        generateStartFrames: data.generateStartFrames,
        generateVoices: data.generateVoices,
      }),
      scopedDb.shots.listBySequence(sequence.id),
    ]);
    const estimate = await estimateContinueCost({
      sequence,
      shots,
      work: planWork(
        plan,
        switchStopAt({
          saved: {
            generateStartFrames: sequence.generateStartFrames,
            generateVoices: sequence.generateVoices,
          },
          requested: {
            generateStartFrames: data.generateStartFrames,
            generateVoices: data.generateVoices,
          },
          stopAt: data.stopAt,
          plan,
        })
      ),
      generateStartFrames: data.generateStartFrames,
      draftMotion: data.draftMotion,
    });
    return { estimateMicros: estimate.priced ? Number(estimate.micros) : null };
  });

/**
 * Create new sequence(s) with different analysis models.
 * Triggers storyboard generation workflow for each.
 *
 * The heavy lifting lives in `createSequences` (src/sequences/server) so the
 * public API one-shot endpoint shares the exact same credit pre-flight,
 * fan-out, element promotion, and workflow trigger.
 */
export const createSequenceFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(createSequenceSchema))
  .handler(async ({ data, context }) => {
    const { sequences } = await createSequences(data, {
      scopedDb: context.scopedDb,
      user: context.user,
      teamId: context.teamId,
    });
    return sequences;
  });

/**
 * Continue a sequence up to `stopAt` (#1408, #1817). What runs is the
 * generation plan filtered to missing / stale work up to the stop — the same
 * plan the footer shows, so the two cannot disagree. Turning Start frames or
 * Voices on only adds units; turning one off after its units exist is refused.
 * Does not wipe existing shots — storyboard runs in resume mode. Everything is
 * checked before a credit is reserved or the mutex claimed.
 */
export const continueGenerationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      continueFlagsSchema.extend({
        leftoverGrokShotIds: z.array(ulidSchema).optional(),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb } = context;
    // Refuse before anything saves: the switches below are written onto the
    // row the trigger snapshots, so a click on a running sequence must not
    // touch it (the trigger's own mutex would refuse only after the write).
    await getSequenceRejectingActiveRun(scopedDb, sequence.id);
    const saved = {
      generateStartFrames: sequence.generateStartFrames,
      generateVoices: sequence.generateVoices,
    };
    const requested = {
      generateStartFrames: data.generateStartFrames,
      generateVoices: data.generateVoices,
    };
    const current = await computeGenerationPlan(scopedDb, sequence.id);
    const next =
      saved.generateStartFrames === requested.generateStartFrames &&
      saved.generateVoices === requested.generateVoices
        ? current
        : await computeGenerationPlan(scopedDb, sequence.id, requested);
    const { work, stopAt } = continueFromPlan({
      current,
      next,
      saved,
      requested,
      stopAt: data.stopAt,
    });
    const shots = await scopedDb.shots.listBySequence(sequence.id);
    const estimate = await estimateContinueCost({
      sequence,
      shots,
      work,
      generateStartFrames: requested.generateStartFrames,
      draftMotion: data.draftMotion,
    });
    // A balance check, not a hold: the run's per-shot children each
    // preflight their own spend against the balance (as Update all's do) and
    // never draw from a reservation, so a hold would refuse them (#1818).
    await requireCredits(scopedDb, estimate.micros, {
      providers: ['fal', 'openrouter'],
      errorMessage: 'Insufficient credits to continue generation',
    });

    // The trigger snapshots these off the row, so they save first — and are
    // put back if it refuses (a run already in flight, no style…): a rejected
    // click must not leave its switches on a sequence nothing ran with.
    const settings = {
      generationStopAt: stopAt,
      generateStartFrames: requested.generateStartFrames,
      generateVoices: requested.generateVoices,
      draftMotion: data.draftMotion,
    };
    const before = {
      generationStopAt: resolveStopAt({
        generationStopAt: sequence.generationStopAt,
      }),
      generateStartFrames: sequence.generateStartFrames,
      generateVoices: sequence.generateVoices,
      draftMotion: sequence.draftMotion,
    };
    await scopedDb.sequences.update({ id: data.sequenceId, ...settings });

    const restoreOnThrow = async <T>(run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        await scopedDb.sequences.update({ id: data.sequenceId, ...before });
        throw error;
      }
    };

    return restoreOnThrow(async () =>
      triggerContinue(context.scopedDb, {
        userId: context.user.id,
        teamId: context.teamId,
        sequence,
        // The units, frozen now with every input read from D1 — after the
        // switches saved, so a shot's mode is the one this click chose.
        plan: await computePlan({
          scopedDb,
          sequenceId: sequence.id,
          units: work.map(({ kind, id }) => ({ kind, id })),
          userId: context.user.id,
        }),
        stopAt,
        leftoverGrokShotIds: data.leftoverGrokShotIds,
      })
    );
  });

/**
 * Update a sequence.
 * Triggers storyboard regeneration if script/style/aspectRatio/model changes.
 */
export const updateSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(updateSequenceSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    const { sequenceId: _sequenceId, ...update } = data;
    return await updateSequence(
      context.scopedDb,
      { userId: context.user.id, teamId: context.teamId },
      context.sequence,
      { ...update, aspectRatio: update.aspectRatio ?? DEFAULT_ASPECT_RATIO }
    );
  });

// ============================================================================
// Set Music Preference (theatre playback + MP4 export)
// ============================================================================

const setSequenceMusicInputSchema = z.object({
  sequenceId: ulidSchema,
  includeMusic: z.boolean(),
});

/**
 * Persist the per-sequence "include music in playback + export" toggle (#834).
 *
 * Deliberately separate from {@link updateSequenceFn}: that path force-defaults
 * `aspectRatio` and runs regeneration/credit logic, so reusing it for a
 * music-only write would silently reset a non-16:9 sequence's aspect ratio.
 * This is a minimal preference write with no side effects.
 */
export const setSequenceMusicFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(setSequenceMusicInputSchema))
  .handler(async ({ data, context }) => {
    return await context.scopedDb.sequences.update({
      id: data.sequenceId,
      includeMusic: data.includeMusic,
    });
  });

/**
 * Persist the film-length target (#1593): seconds, or null for auto. The
 * pipeline never reads it (a scene's length is its script label); it is the
 * enhance target, the credit estimate's duration and the rail chip. Separate
 * from {@link updateSequenceFn} for the reasons {@link setSequenceMusicFn} is.
 */
export const setSequenceTargetDurationFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        targetDurationSeconds: z.int().min(5).nullable(),
      })
    )
  )
  .handler(async ({ data, context }) => {
    return await context.scopedDb.sequences.update({
      id: data.sequenceId,
      targetDurationSeconds: data.targetDurationSeconds,
    });
  });

/**
 * Persist the sequence video-model default. Ungenerated shots inherit this
 * as the sequence tier, and Sequence settings reads it as the Video badge
 * until a clip exists. Separate from {@link updateSequenceFn} for the
 * reasons {@link setSequenceMusicFn} is.
 *
 * The generate-shots picker writes this on change so the inspector, packing
 * preview, and settings row agree before anyone clicks Generate. Batch
 * generate still writes it too, as a safety net.
 */
export const setSequenceVideoModelFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        videoModel: z.string().refine(isValidImageToVideoModel, {
          message: 'Invalid video model',
        }),
      })
    )
  )
  .handler(async ({ data, context }) => {
    if (data.videoModel === context.sequence.videoModel) {
      return context.sequence;
    }
    return await context.scopedDb.sequences.update({
      id: data.sequenceId,
      videoModel: data.videoModel,
    });
  });

// ============================================================================
// Rename (#1108 Phase 4)
// ============================================================================

const renameSequenceInputSchema = z.object({
  sequenceId: ulidSchema,
  title: z.string().trim().min(1).max(500),
});

/**
 * Rename a sequence. Deliberately separate from {@link updateSequenceFn} for
 * the same reason as {@link setSequenceMusicFn}: that path force-defaults
 * `aspectRatio` and treats its mere presence as a regeneration trigger, so a
 * title-only write through it would either reset a non-16:9 sequence's aspect
 * ratio or charge credits and wipe the storyboard. Minimal write, no side
 * effects beyond the event.
 */
export const renameSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(renameSequenceInputSchema))
  .handler(async ({ data, context }) =>
    renameSequence(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence,
      data.title
    )
  );

// ============================================================================
// Retry Failed Storyboard
// ============================================================================

const retryStoryboardInputSchema = z.object({
  sequenceId: ulidSchema,
});

/**
 * Retry a failed storyboard workflow.
 * Re-triggers the full analyze-script pipeline for the sequence.
 */
export const retryStoryboardFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(retryStoryboardInputSchema))
  .handler(async ({ context }) => {
    const { sequence, user, teamId } = context;

    if (sequence.status !== 'failed') {
      throw new Error('Only failed sequences can be retried');
    }

    const stopAt = resolveStopAt({
      generationStopAt: sequence.generationStopAt,
    });
    const reservationId = allowsUnfundedGeneration(stopAt)
      ? undefined
      : await reserveRunCredits(
          context.scopedDb,
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
            errorMessage: 'Insufficient credits to retry storyboard',
            sequenceId: sequence.id,
          }
        );

    const workflowInput: StoryboardTriggerInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
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
    };

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    await releaseReservationOnThrow(context.scopedDb, reservationId, () =>
      triggerStoryboard(context.scopedDb, workflowInput)
    );

    return { success: true };
  });

/** Archive a sequence (hides from list, lets in-flight workflows finish). */
export const archiveSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    await archiveSequence(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence
    );
    return { success: true };
  });

/** Undo an archive, restoring the status recorded when it was archived. */
export const unarchiveSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    const status = await unarchiveSequence(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence
    );
    return { success: true, status };
  });

/**
 * Distinct audio models that have generated a track for this sequence (#546).
 * Drives the header audio-model dropdown.
 */
export const getSequenceAudioModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceVariants.listMusicModels(
      context.sequence.id
    );
  });

/** All music variant rows for a sequence (#546). */
export const getSequenceAudioVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceVariants.listMusicBySequence(
      context.sequence.id
    );
  });

/**
 * Add a new image / video / audio model to an existing sequence (#547).
 * Generates that model's output for every eligible shot (image/video) or the
 * whole sequence (audio) using the EXISTING prompts — no re-analysis. Each unit
 * lands as a version row (image/video) or `sequence_music_variants` row
 * (audio), opened `pending` so the new model appears in the header dropdown
 * immediately. Reuses the per-shot image / motion-batch / music
 * workflows unchanged.
 */
export const addModelToSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        variantType: z.enum(VARIANT_TYPES),
        model: z.string().min(1),
      })
    )
  )
  .handler(({ data, context }) => addModelToSequence(context, data));

/**
 * Promote a model to the live primary across the WHOLE sequence (#547) — the
 * sequence-wide "Set" that pairs with the header image/video dropdowns. For
 * every shot that has a completed `shot_variants` row for `model`, copies that
 * row onto the legacy primary columns (reusing `buildPromoteUpdate`). Shots
 * the model never generated are left on their current primary. Image promotion
 * invalidates each affected shot's video (the start image changed); video
 * promotion is terminal. Audio is per-sequence — use `setMusicFromVariantFn`.
 */
export const setSequenceModelFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        variantType: z.enum(['image', 'video']),
        model: z.string().min(1),
      })
    )
  )
  .handler(({ data, context }) => setSequenceModel(context, data));

/**
 * Trigger sequence-level music generation.
 * Uses pre-generated prompt/tags when available, otherwise builds from shot audio specs.
 */
export const generateMusicFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        prompt: z.string().optional(),
        tags: z.string().optional(),
        model: z.string().optional(),
        duration: z.number().min(1).max(600).optional(),
      })
    )
  )
  .handler(({ data, context }) =>
    generateMusic(
      context.scopedDb,
      { userId: context.user.id },
      context.sequence,
      data
    )
  );
