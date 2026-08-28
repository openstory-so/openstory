import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  estimateAudioCost,
  estimateImageCost,
  estimateVideoCost,
  gateEstimate,
} from '@/lib/billing/cost-estimation';
import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { sumShotDurationsSeconds } from '@/lib/sequences/shot-durations';
import { multiplyMicros } from '@/lib/billing/money';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/lib/billing/preflight';
import { estimateStoryboardPreflightCost } from '@/lib/billing/storyboard-preflight-cost';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { Shot } from '@/lib/db/schema';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/lib/scenes/scene-script';
import { buildShotImageWorkflowInput } from '@/lib/image/build-shot-image-input';
import { toShotView, type ShotView } from '@/lib/shots/shot-view';
import {
  motionPromptFromVersion,
  resolveMotionPrompt,
} from '@/lib/motion/resolve-motion-prompt';
import { VARIANT_TYPES, type VariantType } from '@/lib/db/schema/shot-variants';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  createSequenceSchema,
  MUSIC_REQUIRES_MOTION_ERROR,
  updateSequenceSchema,
} from '@/lib/schemas/sequence.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { triggerStoryboard } from '@/lib/workflow/launchers';
import type {
  BatchMotionMusicWorkflowInput,
  MusicWorkflowInput,
  StoryboardTriggerInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';
import { bumpStylePopularity } from '@/lib/style/bump-style-popularity';
import { simpleHash } from '@/lib/utils/hash';
import { getLogger } from '@/lib/observability/logger';
import { createSequences } from '@/lib/sequences/create-sequences';

const logger = getLogger(['openstory', 'serverFn', 'sequences']);

/**
 * Result of {@link addModelToSequenceFn}. `count` is the number of generation
 * units actually started (1 track for audio; eligible shots for video; shots
 * whose `/image` workflow successfully triggered for image). `failed` is the
 * number of units that failed to start — only ever non-zero for the image path,
 * which triggers one workflow per shot and tolerates partial failure. Mirrored
 * by `useAddModelToSequence`'s mutation generic.
 */
export type AddModelResult = {
  workflowRunId: string;
  variantType: VariantType;
  model: string;
  count: number;
  failed: number;
};

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

/**
 * Create new sequence(s) with different analysis models.
 * Triggers storyboard generation workflow for each.
 *
 * The heavy lifting lives in `createSequences` (src/lib/sequences) so the
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
 * Music only generates inside the motion phase (#823), so an update whose
 * merged flags leave music on without motion would strand music as a silent
 * no-op on the next regeneration. The schema alone can't catch this — it
 * doesn't see the persisted flags a partial update leaves untouched.
 */
export const musicWithoutMotion = (
  update: { autoGenerateMusic?: boolean; autoGenerateMotion?: boolean },
  existing: { autoGenerateMusic: boolean; autoGenerateMotion: boolean }
): boolean =>
  (update.autoGenerateMusic ?? existing.autoGenerateMusic) &&
  !(update.autoGenerateMotion ?? existing.autoGenerateMotion);

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
    const { sequenceId, ...updateData } = data;

    if (musicWithoutMotion(updateData, context.sequence)) {
      throw new Error(MUSIC_REQUIRES_MOTION_ERROR);
    }

    const needsRegeneration =
      updateData.script !== undefined ||
      updateData.styleId !== undefined ||
      updateData.aspectRatio !== undefined ||
      updateData.analysisModel !== undefined;

    const previousStyleId = context.sequence.styleId;

    // No eager 'processing' write: `triggerStoryboard` owns the status flip
    // below, so a rejected trigger (mutex held, no script) leaves the sequence
    // in its real state instead of a spinner that never resolves.
    const sequence = await context.scopedDb.sequences.update({
      id: sequenceId,
      aspectRatio: updateData.aspectRatio ?? DEFAULT_ASPECT_RATIO,
      ...updateData,
    });

    // sequences.styleId is `.notNull() + onDelete: 'set null'` — TS types it as
    // non-null but the runtime value can be null after the parent style is
    // deleted. Keep the runtime guard despite what the type says.
    if (
      updateData.styleId !== undefined &&
      updateData.styleId !== previousStyleId &&
      sequence.styleId
    ) {
      bumpStylePopularity({
        scopedDb: context.scopedDb,
        styleId: sequence.styleId,
        sequenceIds: [sequence.id],
        teamId: context.teamId,
        userId: context.user.id,
      });
    }

    if (needsRegeneration) {
      const reservationId = await reserveRunCredits(
        context.scopedDb,
        estimateStoryboardPreflightCost({
          script: sequence.script ?? '',
          imageModel: safeTextToImageModel(
            sequence.imageModel,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
          autoGenerateMotion: sequence.autoGenerateMotion,
          videoModels: [
            safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
          ],
          autoGenerateMusic: sequence.autoGenerateMusic,
          audioModels: [
            safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL),
          ],
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
      await releaseReservationOnThrow(context.scopedDb, reservationId, () =>
        triggerStoryboard(context.scopedDb, {
          userId: context.user.id,
          teamId: context.teamId,
          sequenceId,
          reservationId,
          options: {
            shotsPerScene: 3,
            generateThumbnails: true,
            generateDescriptions: true,
            aiProvider: 'openrouter',
            regenerateAll: true,
          },
          autoGenerateMotion: sequence.autoGenerateMotion,
          autoGenerateMusic: sequence.autoGenerateMusic,
        })
      );
    }

    return sequence;
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
  .handler(async ({ data, context }) => {
    const prevTitle = context.sequence.title;
    const sequence = await context.scopedDb.sequences.update({
      id: data.sequenceId,
      title: data.title,
    });
    if (data.title !== prevTitle) {
      await context.scopedDb.sequenceEvents.record({
        sequenceId: data.sequenceId,
        actorId: context.user.id,
        kind: 'sequence.renamed',
        targetType: 'sequence',
        targetId: data.sequenceId,
        summary: `Renamed sequence to ${data.title}`,
        data: { prevTitle },
      });
    }
    return sequence;
  });

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

    const reservationId = await reserveRunCredits(
      context.scopedDb,
      estimateStoryboardPreflightCost({
        script: sequence.script ?? '',
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        aspectRatio: sequence.aspectRatio,
        autoGenerateMotion: sequence.autoGenerateMotion,
        videoModels: [
          safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
        ],
        autoGenerateMusic: sequence.autoGenerateMusic,
        audioModels: [safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL)],
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
      autoGenerateMotion: sequence.autoGenerateMotion,
      autoGenerateMusic: sequence.autoGenerateMusic,
    };

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    await releaseReservationOnThrow(context.scopedDb, reservationId, () =>
      triggerStoryboard(context.scopedDb, workflowInput)
    );

    return { success: true };
  });

/** Archive a sequence (hides from list, lets in-flight workflows finish).
 * Records the prior status so {@link unarchiveSequenceFn} can restore it. */
export const archiveSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    const prevStatus = context.sequence.status;
    if (prevStatus === 'archived') return { success: true };
    await context.scopedDb
      .sequence(context.sequence.id)
      .updateStatus('archived');
    await context.scopedDb.sequenceEvents.record({
      sequenceId: context.sequence.id,
      actorId: context.user.id,
      kind: 'sequence.archived',
      targetType: 'sequence',
      targetId: context.sequence.id,
      summary: `Archived ${context.sequence.title}`,
      data: { prevState: { status: prevStatus } },
    });
    return { success: true };
  });

/**
 * Statuses an unarchive may restore verbatim. `'processing'` is deliberately
 * NOT here: archiving lets the in-flight run finish, so by unarchive time the
 * generation is over one way or the other, and re-asserting 'processing'
 * makes the editor poll and show "Generating…" for a run that is not
 * happening. The cron reconciler only heals such a row while its Cloudflare
 * instance is still resolvable, so a long-archived sequence would stay stuck.
 * A recorded 'processing' maps to {@link INTERRUPTED_STATUS} instead — the
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
const INTERRUPTED_STATUS = {
  status: 'failed' as const,
  error: 'Generation was interrupted — use Retry to run it again.',
};

/**
 * Undo an archive (#1108 Phase 4): restore the status the sequence had when
 * it was archived (from the `sequence.archived` event's prevState). Sequences
 * archived before that event existed fall back to a content-derived status —
 * 'completed' when the sequence has shots, else 'draft'.
 */
export const unarchiveSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .validator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    const { scopedDb, sequence, user } = context;
    if (sequence.status !== 'archived') {
      return { success: true, status: sequence.status };
    }
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
      (await scopedDb.shots.listBySequence(sequence.id, { limit: 1 })).length >
      0;
    const { status, interrupted } = resolveUnarchiveRestore({
      recordedStatus,
      hasShots,
    });

    await scopedDb
      .sequence(sequence.id)
      .updateStatus(status, interrupted ? INTERRUPTED_STATUS.error : null);
    await scopedDb.sequenceEvents.record({
      sequenceId: sequence.id,
      actorId: user.id,
      kind: 'sequence.unarchived',
      targetType: 'sequence',
      targetId: sequence.id,
      summary: `Unarchived ${sequence.title}`,
      data: { restoredStatus: status },
    });
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
 * Throw if `model` is already on the sequence (#547). A model counts as
 * "already added" only when a NON-failed (pending/generating/completed) variant
 * row exists for it — a previously failed add can always be retried. Shared by
 * all three add-model branches; `label` ('image' | 'video' | 'audio') shapes
 * the error message.
 */
export function assertModelNotAlreadyAdded(
  existing: ReadonlyArray<{ model: string; status: string }>,
  model: string,
  label: VariantType
): void {
  if (existing.some((v) => v.model === model && v.status !== 'failed')) {
    throw new Error(`That ${label} model is already on this sequence`);
  }
}

/**
 * Shots eligible for a video add-model run (#547): only those with a completed
 * primary image to animate. A shot with no usable image is skipped — there is
 * nothing to feed image-to-video.
 */
export function selectEligibleVideoShots(
  shots: readonly ShotView[]
): ShotView[] {
  return shots.filter(
    (f) => f.frame.imageStatus === 'completed' && Boolean(f.image?.url)
  );
}

/**
 * Build the music-workflow input for an ADD-MODEL audio run (#547). Always
 * `isPrimary: false`: an added audio model lands as an alternate in
 * `sequence_music_variants` and must never repoint the live `sequences.music*`
 * primary track. The music workflow defaults `isPrimary` to true (#546), so
 * omitting it here would clobber the user's working primary on both success AND
 * failure — the exact regression this helper exists to prevent.
 */
export function buildAddAudioMusicInput(args: {
  baseCtx: { userId: string; teamId: string; sequenceId: string };
  prompt: string;
  tags: string;
  durationSeconds: number;
  model: MusicWorkflowInput['model'];
}): MusicWorkflowInput {
  return {
    ...args.baseCtx,
    prompt: args.prompt,
    tags: args.tags,
    duration: args.durationSeconds,
    model: args.model,
    isPrimary: false,
  };
}

/**
 * Add a new image / video / audio model to an existing sequence (#547).
 * Generates that model's output for every eligible shot (image/video) or the
 * whole sequence (audio) using the EXISTING prompts — no re-analysis. Each unit
 * lands as a `shot_variants` row (image/video) or `sequence_music_variants`
 * row (audio), pre-stamped `pending` so the new model appears in the header
 * dropdown immediately. Reuses the per-shot image / motion-batch / music
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
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb, user } = context;
    const { variantType, model } = data;
    const baseCtx = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
    };

    // ── Audio: one new track for the sequence ──────────────────────────────
    if (variantType === 'audio') {
      if (!isValidAudioModel(model)) {
        throw new Error('Invalid audio model');
      }
      const existing = await scopedDb.sequenceVariants.listMusicBySequence(
        sequence.id
      );
      assertModelNotAlreadyAdded(existing, model, 'audio');
      const musicPrompt = sequence.musicPrompt;
      const musicTags = sequence.musicTags;
      if (!musicPrompt || !musicTags) {
        throw new Error(
          'Generate music once before adding another audio model'
        );
      }
      const allShots = await scopedDb.shots.listBySequence(sequence.id);
      const totalDuration = sumShotDurationsSeconds(allShots) || 30;

      const reservationId = await reserveRunCredits(
        scopedDb,
        gateEstimate(
          estimateAudioCost(model, totalDuration, {
            pricing: await getEffectiveFalPricing(),
          }),
          { model, operation: 'add-audio-model' }
        ),
        {
          errorMessage: 'Insufficient credits to add this audio model',
          sequenceId: sequence.id,
        }
      );

      try {
        return await releaseReservationOnThrow(
          scopedDb,
          reservationId,
          async () => {
            await scopedDb.sequenceVariants.upsertMusicPrimary({
              sequenceId: sequence.id,
              model,
              prompt: musicPrompt,
              tags: musicTags,
              durationSeconds: Math.round(totalDuration),
              status: 'pending',
            });

            const musicInput = {
              ...buildAddAudioMusicInput({
                baseCtx,
                prompt: musicPrompt,
                tags: musicTags,
                durationSeconds: totalDuration,
                model,
              }),
              reservationId,
              ownsReservation: true,
            };
            const workflowRunId = await triggerWorkflow('/music', musicInput, {
              deduplicationId: `add-audio-${sequence.id}-${model}-${Date.now()}`,
              label: buildWorkflowLabel(sequence.id),
            });
            return {
              workflowRunId,
              variantType,
              model,
              count: 1,
              failed: 0,
            } satisfies AddModelResult;
          }
        );
      } catch (error) {
        logger.error('add-model: failed to trigger music workflow', {
          err: error,
          sequenceId: sequence.id,
          model,
        });
        // Mark the pre-stamped row failed so the model can be re-added. Guard
        // the compensating write so its own failure can't mask the original
        // trigger error (which is what we want to surface to the user).
        try {
          await scopedDb.sequenceVariants.upsertMusicPrimary({
            sequenceId: sequence.id,
            model,
            prompt: musicPrompt,
            tags: musicTags,
            durationSeconds: Math.round(totalDuration),
            status: 'failed',
          });
        } catch (cleanupError) {
          logger.error('add-model: failed to mark music row failed', {
            err: cleanupError,
            sequenceId: sequence.id,
            model,
          });
        }
        throw error;
      }
    }

    // ── Video: animate every shot that already has an image ───────────────
    if (variantType === 'video') {
      if (!isValidImageToVideoModel(model)) {
        throw new Error('Invalid video model');
      }
      // Video lives in `video_variants` now (#990); a row's covered shots are
      // in its manifest, but the add-guard only needs (model, status).
      const existing = await scopedDb.videoVariants.listBySequence(sequence.id);
      assertModelNotAlreadyAdded(existing, model, 'video');
      const allShots = await scopedDb.shots.listBySequence(sequence.id);
      // Eligibility and the per-shot `imageUrl` below read the anchor frame's
      // selected still, so every shot needs its anchor first (#989).
      await scopedDb.shots.ensureAnchorFrames(allShots);
      const anchorsByShot = new Map(
        (await scopedDb.frames.listAnchorsBySequence(sequence.id)).map((fr) => [
          fr.shotId,
          fr,
        ])
      );
      const [
        selectedByFrame,
        selectedPromptByFrame,
        selectedVideoByShot,
        primaryVideoByShot,
      ] = await Promise.all([
        scopedDb.frameVariants.getSelectedByFrameIds(
          [...anchorsByShot.values()].map((fr) => fr.id)
        ),
        scopedDb.framePromptVersions.getSelectedByFrameIds(
          [...anchorsByShot.values()].map((fr) => fr.id)
        ),
        scopedDb.videoVariants.getSelectedByShotIds(allShots.map((s) => s.id)),
        scopedDb.videoVariants.getPrimaryByShotIds(allShots.map((s) => s.id)),
      ]);
      const shotViews = allShots.flatMap((shot) => {
        const frame = anchorsByShot.get(shot.id);
        return frame
          ? [
              toShotView(shot, frame, {
                image: selectedByFrame.get(frame.id) ?? null,
                // Eligibility only — nothing here renders a thumbnail, so the
                // pre-prompt stand-in (#1101) is not resolved.
                preview: null,
                imagePromptVersion: selectedPromptByFrame.get(frame.id) ?? null,
                video: selectedVideoByShot.get(shot.id) ?? null,
                primaryVideo: primaryVideoByShot.get(shot.id) ?? null,
              }),
            ]
          : [];
      });
      const eligible = selectEligibleVideoShots(shotViews);
      if (eligible.length === 0) {
        throw new Error('No shots have a completed image to animate yet');
      }

      const reservationId = await reserveRunCredits(
        scopedDb,
        multiplyMicros(
          gateEstimate(
            estimateVideoCost(model, 5, {
              pricing: await getEffectiveFalPricing(),
            }),
            { model, operation: 'add-video-model' }
          ),
          eligible.length
        ),
        {
          errorMessage: 'Insufficient credits to add this video model',
          sequenceId: sequence.id,
        }
      );

      try {
        const workflowRunId = await releaseReservationOnThrow(
          scopedDb,
          reservationId,
          async () => {
            const sceneContext = await loadSceneContextBySequence(
              scopedDb,
              sequence.id
            );
            const sceneOf = (s: Pick<Shot, 'sceneId' | 'durationMs'>) =>
              resolveSceneForShot(s, sceneContext).scene;

            // No pre-seeded `video_variants` version here (mirrors the image branch
            // below, #990): each shot's motion child opens its own in-flight
            // `video_variants` version in `set-generating-status` (keyed by
            // (renderSegmentId, model, workflowRunId), materializing the degenerate
            // one-shot segment), and the workflow's `onFailure` marks it failed.
            // Pre-seeding a `pending` row the workflow can't reconcile (it dedupes on
            // the run id the pending row lacks) would orphan it and — being non-failed
            // — permanently block re-adding the model via `assertModelNotAlreadyAdded`.
            // Structured motion prompt now lives on the shot's selected
            // `shot_prompt_versions` row (#713), not `metadata.prompts.motion`. Batch
            // it once; `motion-batch` re-assembles per model from `motionPrompt`.
            const selectedMotionByShot =
              await scopedDb.shotPromptVersions.getSelectedMotionByShots(
                eligible.map((f) => f.id)
              );
            const workflowInput: BatchMotionMusicWorkflowInput = {
              ...baseCtx,
              reservationId,
              includeMusic: false,
              videoModels: [model],
              // Adding a video model lands as an alternate only — never the primary
              // video. Promote later with "Set". (#547)
              variantOnly: true,
              shots: eligible.map((f) => {
                const selectedMotion = selectedMotionByShot.get(f.id);
                const motionPrompt = selectedMotion
                  ? motionPromptFromVersion(selectedMotion)
                  : undefined;
                return {
                  shotId: f.id,
                  imageUrl: f.image?.url ?? '',
                  prompt: resolveMotionPrompt(
                    {
                      motionPrompt: motionPrompt ?? null,
                      characterTags: sceneOf(f)?.continuity?.characterTags,
                      description: sceneOf(f)?.originalScript.extract ?? null,
                    },
                    model
                  ),
                  model,
                  motionPrompt,
                  sceneTitle: sceneOf(f)?.metadata?.title,
                  characterTags: sceneOf(f)?.continuity?.characterTags,
                  duration: f.durationMs ? f.durationMs / 1000 : 3,
                  aspectRatio: sequence.aspectRatio,
                };
              }),
            };
            return triggerWorkflow('/motion-batch', workflowInput, {
              deduplicationId: `add-video-${sequence.id}-${model}-${Date.now()}`,
              label: buildWorkflowLabel(sequence.id),
            });
          }
        );
        return {
          workflowRunId,
          variantType,
          model,
          count: eligible.length,
          failed: 0,
        } satisfies AddModelResult;
      } catch (error) {
        // No compensating cleanup needed: nothing is pre-written, and a failed
        // batch trigger means no motion child ran, so no `video_variants`
        // version exists to mark failed (the model stays cleanly re-addable).
        logger.error('add-model: failed to trigger motion batch', {
          err: error,
          sequenceId: sequence.id,
          model,
          shots: eligible.length,
        });
        throw error;
      }
    }

    // ── Image: re-render every shot's prompt with the new model ───────────
    if (!isValidTextToImageModel(model)) {
      throw new Error('Invalid image model');
    }
    // Image variants live in `frame_variants` now (#989) — check the models that
    // already have a version there rather than the retired `shot_variants(image)`.
    const existingImageModels =
      await scopedDb.frameVariants.listModelsForSequence(sequence.id);
    if (existingImageModels.includes(model)) {
      throw new Error(`Image model "${model}" has already been added`);
    }
    const allShots = await scopedDb.shots.listBySequence(sequence.id);
    await scopedDb.shots.ensureAnchorFrames(allShots);
    // Keyed by shotId: frame ids are NOT shot ids (#989), and the lookup below
    // holds a shot.
    const imageFrames = await scopedDb.frames.listBySequence(sequence.id);
    const imageFramesByShotId = new Map(
      imageFrames.map((fr) => [fr.shotId, fr])
    );
    const promptByFrameId =
      await scopedDb.framePromptVersions.getSelectedByFrameIds(
        imageFrames.map((fr) => fr.id)
      );
    const [characters, locations, elements, imageSceneContext] =
      await Promise.all([
        scopedDb.characters.listWithSheets(sequence.id),
        scopedDb.sequenceLocations.listWithReferences(sequence.id),
        scopedDb.sequenceElements.list(sequence.id),
        loadSceneContextBySequence(scopedDb, sequence.id),
      ]);

    const inputs: NonNullable<
      Awaited<ReturnType<typeof buildShotImageWorkflowInput>>
    >[] = [];
    for (const f of allShots) {
      const anchorFrame = imageFramesByShotId.get(f.id);
      const selectedPrompt = anchorFrame
        ? promptByFrameId.get(anchorFrame.id)
        : undefined;
      const input = await buildShotImageWorkflowInput({
        shot: f,
        scene: resolveSceneForShot(f, imageSceneContext).scene,
        model,
        userId: user.id,
        teamId: sequence.teamId,
        sequenceId: sequence.id,
        aspectRatio: sequence.aspectRatio,
        characters,
        locations,
        elements,
        imagePrompt: selectedPrompt?.text ?? null,
        // Adding a model never repoints the primary — it lands as an alternate
        // variant only. Promote later with "Set". (#547)
        variantOnly: true,
      });
      // The anchor + the prompt version this render is built from, snapshotted
      // here so the workflow stamps the variant with the prompt it actually
      // rendered rather than whatever the pointer says when it runs (#1070).
      if (input)
        inputs.push({
          ...input,
          frameId: anchorFrame?.id,
          promptVersionId: selectedPrompt?.id ?? null,
        });
    }
    if (inputs.length === 0) {
      throw new Error('No shots have a prompt to generate from');
    }

    const perShotCost = gateEstimate(
      estimateImageCost(model, sequence.aspectRatio, 1, {
        pricing: await getEffectiveFalPricing(),
      }),
      { model, operation: 'add-image-model' }
    );

    // Trigger one image workflow per shot, each with its own hold. A shared
    // envelope would let the first child to finish zero leftover for siblings.
    // A single shot's trigger failure shouldn't abort the rest of the batch.
    // Only throw if every shot failed to trigger.
    // No pre-seeded variant row: the IMAGE_WORKFLOW (variantOnly) appends the
    // in-flight `frame_variants` 'model' version itself in set-generating-status,
    // and its onFailure marks it failed — so there's nothing to pre-write here.
    let workflowRunId = '';
    let triggered = 0;
    for (const input of inputs) {
      let reservationId: string | undefined;
      try {
        reservationId = await reserveRunCredits(scopedDb, perShotCost, {
          errorMessage: 'Insufficient credits to add this image model',
          sequenceId: sequence.id,
        });
      } catch (error) {
        logger.error('add-model: insufficient credits for remaining shots', {
          err: error,
          sequenceId: sequence.id,
          model,
          triggered,
        });
        if (triggered === 0) throw error;
        break;
      }
      try {
        workflowRunId = await triggerWorkflow(
          '/image',
          { ...input, reservationId, ownsReservation: true },
          {
            deduplicationId: `add-image-${input.shotId}-${model}-${Date.now()}`,
            label: buildWorkflowLabel(sequence.id),
          }
        );
        triggered++;
      } catch (error) {
        // Log every per-shot trigger failure so a systemic cause (e.g. a
        // transient binding issue hitting half the batch) leaves an aggregated
        // Sentry trace rather than vanishing.
        logger.error('add-model: failed to trigger image workflow for shot', {
          err: error,
          sequenceId: sequence.id,
          shotId: input.shotId,
          model,
        });
        if (reservationId) {
          try {
            await scopedDb.billing.zeroReservation(reservationId);
          } catch (releaseError) {
            logger.error('add-model: failed to zero image reservation', {
              err: releaseError,
              sequenceId: sequence.id,
              reservationId,
            });
          }
        }
      }
    }
    if (triggered === 0) {
      throw new Error('Failed to start image generation for any shot');
    }
    return {
      workflowRunId,
      variantType,
      model,
      count: triggered,
      failed: inputs.length - triggered,
    } satisfies AddModelResult;
  });

/**
 * Promote a model to the live primary across the WHOLE sequence (#547) — the
 * sequence-wide "Set" that pairs with the header image/video dropdowns. For
 * every shot that has a completed `shot_variants` row for `model`, copies that
 * row onto the legacy primary columns (the per-scene `setImageFromVariantFn` /
 * `setVideoFromVariantFn` applied in bulk, reusing `buildPromoteUpdate`). Shots
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
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb, user } = context;
    const { variantType, model } = data;

    if (variantType === 'image' && !isValidTextToImageModel(model)) {
      throw new Error('Invalid image model');
    }
    if (variantType === 'video' && !isValidImageToVideoModel(model)) {
      throw new Error('Invalid video model');
    }

    // Image variants live in `frame_variants` now (#989). The sequence-wide
    // "Set" is a per-shot pointer repoint (the #677 fix applied in bulk): for
    // every shot with a completed version for `model`, select it and reset that
    // shot's now-stale video.
    if (variantType === 'image') {
      const versions = await scopedDb.frameVariants.listModelVersionsBySequence(
        sequence.id
      );
      const latestByFrame = new Map<string, (typeof versions)[number]>();
      for (const v of versions) {
        if (v.model !== model || v.status !== 'completed' || !v.url) continue;
        latestByFrame.set(v.frameId, v); // versions are asc id → last wins
      }
      if (latestByFrame.size === 0) {
        throw new Error('That model has not generated anything to set');
      }
      let imageCount = 0;
      for (const [frameId, version] of latestByFrame) {
        await scopedDb.frameVariants.select(frameId, version.id, {
          actorId: user.id,
        });
        imageCount++;
      }
      return { count: imageCount, variantType, model };
    }

    // Video lives in `video_variants` now (#990). The sequence-wide "Set" is a
    // per-shot pointer repoint (the #677 fix applied in bulk, mirroring the
    // image branch above): for every shot with a completed version for `model`,
    // select it — `videoVariants.select` mirrors `shots.video*`, repoints the
    // render segment's `selectedVideoVersionId` pointer, and logs the event.
    const versions = await scopedDb.videoVariants.listBySequence(sequence.id);
    const latestByShot = new Map<string, (typeof versions)[number]>();
    for (const version of versions) {
      if (
        version.model !== model ||
        version.status !== 'completed' ||
        !version.url
      ) {
        continue;
      }
      // versions are asc id → last write wins (latest per shot).
      for (const entry of version.manifest) {
        latestByShot.set(entry.shotId, version);
      }
    }
    if (latestByShot.size === 0) {
      throw new Error('That model has not generated anything to set');
    }

    let count = 0;
    for (const [shotId, version] of latestByShot) {
      try {
        await scopedDb.videoVariants.select(shotId, version.id, {
          actorId: user.id,
        });
        count++;
      } catch (error) {
        // Only a shot deleted mid-promotion is benign — skip just that shot.
        // Every other failure (segment mismatch, missing version, DB/batch
        // error) is a real problem: re-throw so it reaches the error boundary
        // rather than being swallowed and reported as a successful "Set".
        if (
          error instanceof Error &&
          error.message === `Shot ${shotId} not found`
        ) {
          logger.warn('set-model: skipped deleted shot during video set', {
            sequenceId: sequence.id,
            shotId,
            model,
          });
          continue;
        }
        throw error;
      }
    }

    // Every candidate shot was deleted mid-promotion — nothing was set, so don't
    // present a no-op as success.
    if (count === 0) {
      throw new Error('That model has not generated anything to set');
    }

    if (count !== latestByShot.size) {
      logger.warn('set-model: promoted fewer shots than promotable', {
        sequenceId: sequence.id,
        model,
        variantType,
        promotable: latestByShot.size,
        promoted: count,
      });
    }

    return { count, variantType, model };
  });

/**
 * Deduplication id for a primary music run. CF instance ids are unique
 * FOREVER, so a constant `music-<sequenceId>` would block every legitimate
 * rerun; instead the id is the music slot's OBSERVED state (status + last
 * generated-at) plus this request's inputs. Two rapid triggers read the same
 * state and collapse onto one instance; a rerun after the slot completed,
 * failed, or with changed inputs hashes differently and starts a fresh run.
 */
function musicRunDedupId(args: {
  sequenceId: string;
  musicStatus: string | null;
  musicGeneratedAt: Date | null;
  prompt: string;
  tags: string;
  duration: number;
  model: string | undefined;
}): string {
  const state = JSON.stringify([
    args.musicStatus,
    args.musicGeneratedAt?.getTime() ?? null,
    args.prompt,
    args.tags,
    args.duration,
    args.model ?? null,
  ]);
  return `music-${simpleHash(state)}-${args.sequenceId}`;
}

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
  .handler(async ({ data, context }) => {
    const { sequence, user } = context;

    const effectivePrompt = data.prompt ?? sequence.musicPrompt;
    const effectiveTags = data.tags ?? sequence.musicTags;

    if (!effectivePrompt) {
      throw new Error(
        'Music prompt has not been generated yet — generate the storyboard first before editing music inputs.'
      );
    }
    if (!effectiveTags) {
      throw new Error('Music tags are required.');
    }

    // Persist the user's intent before triggering the workflow. Both
    // `data.prompt` and `data.tags` are surfaced as a single user-edit
    // revision; the variants helper updates the cached columns on `sequences`
    // alongside the row insert so a tags-only edit isn't dropped.
    if (data.prompt !== undefined || data.tags !== undefined) {
      await context.scopedDb.sequenceMusicPromptVersions.write({
        sequenceId: sequence.id,
        prompt: effectivePrompt,
        tags: effectiveTags,
        source: 'user-edit',
        createdBy: user.id,
      });
    }

    const allShots = await context.scopedDb.shots.listBySequence(
      data.sequenceId
    );

    const totalDuration = sumShotDurationsSeconds(allShots);

    const baseInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      duration: data.duration ?? (totalDuration || 30),
      model:
        data.model && isValidAudioModel(data.model) ? data.model : undefined,
    };

    const musicInput: MusicWorkflowInput = {
      ...baseInput,
      prompt: effectivePrompt,
      tags: effectiveTags,
    };

    await context.scopedDb.sequence(sequence.id).updateMusicFields({
      musicStatus: 'generating',
      musicError: null,
    });

    await triggerWorkflow('/music', musicInput, {
      deduplicationId: musicRunDedupId({
        sequenceId: sequence.id,
        musicStatus: sequence.musicStatus,
        musicGeneratedAt: sequence.musicGeneratedAt,
        prompt: effectivePrompt,
        tags: effectiveTags,
        duration: baseInput.duration,
        model: baseInput.model,
      }),
      label: buildWorkflowLabel(sequence.id),
    });

    return { success: true };
  });
