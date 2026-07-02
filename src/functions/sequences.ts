import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  estimateAudioCost,
  estimateImageCost,
  estimateStoryboardCost,
  estimateVideoCost,
} from '@/lib/billing/cost-estimation';
import { multiplyMicros } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { Shot } from '@/lib/db/schema';
import { buildShotImageWorkflowInput } from '@/lib/image/build-shot-image-input';
import {
  projectShotWithImage,
  type ShotWithImage,
} from '@/lib/shots/shot-with-image';
import {
  motionPromptFromVersion,
  resolveMotionPrompt,
} from '@/lib/motion/resolve-motion-prompt';
import { VARIANT_TYPES, type VariantType } from '@/lib/db/schema/shot-variants';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  createSequenceSchema,
  updateSequenceSchema,
} from '@/lib/schemas/sequence.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { triggerStoryboard } from '@/lib/workflow/launchers';
import type {
  BatchMotionMusicWorkflowInput,
  MusicSceneSummary,
  MusicWorkflowInput,
  StoryboardWorkflowInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';
import { bumpStylePopularity } from '@/lib/style/bump-style-popularity';
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

export const getSequenceFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
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
  .inputValidator(zodValidator(createSequenceSchema))
  .handler(async ({ data, context }) => {
    const { sequences } = await createSequences(data, {
      scopedDb: context.scopedDb,
      user: context.user,
      teamId: context.teamId,
    });
    return sequences;
  });

/**
 * Update a sequence.
 * Triggers storyboard regeneration if script/style/aspectRatio/model changes.
 */
export const updateSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(updateSequenceSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, ...updateData } = data;

    const needsRegeneration =
      updateData.script !== undefined ||
      updateData.styleId !== undefined ||
      updateData.aspectRatio !== undefined ||
      updateData.analysisModel !== undefined;

    const previousStyleId = context.sequence.styleId;

    const sequence = await context.scopedDb.sequences.update({
      id: sequenceId,
      aspectRatio: updateData.aspectRatio ?? DEFAULT_ASPECT_RATIO,
      ...updateData,
      status: needsRegeneration ? 'processing' : undefined,
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
      await requireCredits(
        context.scopedDb,
        estimateStoryboardCost({
          imageModel: safeTextToImageModel(
            sequence.imageModel,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
          videoModels: [
            safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
          ],
        }),
        {
          providers: ['fal', 'openrouter'],
          errorMessage: 'Insufficient credits to regenerate storyboard',
        }
      );

      await triggerWorkflow(
        '/storyboard',
        {
          userId: context.user.id,
          teamId: context.teamId,
          sequenceId,
          options: {
            shotsPerScene: 3,
            generateThumbnails: true,
            generateDescriptions: true,
            aiProvider: 'openrouter',
            regenerateAll: true,
          },
          autoGenerateMotion: sequence.autoGenerateMotion,
          autoGenerateMusic: sequence.autoGenerateMusic,
        } satisfies StoryboardWorkflowInput,
        { label: buildWorkflowLabel(sequence.id) }
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
  .inputValidator(zodValidator(setSequenceMusicInputSchema))
  .handler(async ({ data, context }) => {
    return await context.scopedDb.sequences.update({
      id: data.sequenceId,
      includeMusic: data.includeMusic,
    });
  });

// ============================================================================
// Set Sequence Default Models (#986)
// ============================================================================

const updateSequenceModelsInputSchema = z.object({
  sequenceId: ulidSchema,
  imageModel: z.string().min(1).optional(),
  videoModel: z.string().min(1).optional(),
});

/**
 * Persist the sequence's default image/video model — what scenes with no
 * override inherit (#909). The inspector edits this at sequence scope (#986).
 *
 * Deliberately separate from {@link updateSequenceFn}: that path force-defaults
 * `aspectRatio` and runs regeneration/credit logic. This is a minimal
 * preference write with no side effects, mirroring {@link setSequenceMusicFn}.
 */
export const updateSequenceModelsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(updateSequenceModelsInputSchema))
  .handler(async ({ data, context }) => {
    if (
      data.imageModel !== undefined &&
      !isValidTextToImageModel(data.imageModel)
    ) {
      throw new Error('Invalid image model');
    }
    if (
      data.videoModel !== undefined &&
      !isValidImageToVideoModel(data.videoModel)
    ) {
      throw new Error('Invalid video model');
    }
    return await context.scopedDb.sequences.update({
      id: data.sequenceId,
      ...(data.imageModel !== undefined ? { imageModel: data.imageModel } : {}),
      ...(data.videoModel !== undefined ? { videoModel: data.videoModel } : {}),
    });
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
  .inputValidator(zodValidator(retryStoryboardInputSchema))
  .handler(async ({ context }) => {
    const { sequence, user, teamId } = context;

    if (sequence.status !== 'failed') {
      throw new Error('Only failed sequences can be retried');
    }

    await requireCredits(
      context.scopedDb,
      estimateStoryboardCost({
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        aspectRatio: sequence.aspectRatio,
        videoModels: [
          safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
        ],
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to retry storyboard',
      }
    );

    const workflowInput: StoryboardWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
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
    await triggerStoryboard(context.scopedDb, workflowInput);

    return { success: true };
  });

/** Archive a sequence (hides from list, lets in-flight workflows finish) */
export const archiveSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    await context.scopedDb
      .sequence(context.sequence.id)
      .updateStatus('archived');
    return { success: true };
  });

/** Build compact scene summaries from shots for music prompt generation */
export function buildSceneSummaries(shots: Shot[]): MusicSceneSummary[] {
  return shots.map((shot) => {
    const md = shot.metadata?.musicDesign;
    const legacyMusic = shot.metadata?.audioDesign?.music;
    const meta = shot.metadata?.metadata;
    const durationSeconds = shot.durationMs
      ? shot.durationMs / 1000
      : (meta?.durationSeconds ?? 10);

    return {
      sceneId: shot.id,
      location: meta?.location || '',
      timeOfDay: meta?.timeOfDay || '',
      // Visual context for the music prompt: the scene description. The
      // structured visual prompt components moved to `frame_prompt_versions`
      // (#713), so the shot's own description is the summary source here.
      visualSummary: shot.description || '',
      title: meta?.title || 'Untitled Scene',
      storyBeat: meta?.storyBeat || '',
      durationSeconds,
      musicStyle: md?.style || legacyMusic?.style || '',
      musicMood: md?.mood || legacyMusic?.mood || '',
      musicPresence: md?.presence || legacyMusic?.presence || 'none',
    };
  });
}

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
  // The still-image surface moved onto the anchor frame (#989); callers project
  // it back via `projectShotWithImage` so the thumbnail* reads here are stable.
  shots: readonly ShotWithImage[]
): ShotWithImage[] {
  return shots.filter(
    (f) => f.thumbnailStatus === 'completed' && Boolean(f.thumbnailUrl)
  );
}

/**
 * Sum a sequence's per-shot durations in seconds, falling back to 10s for any
 * shot whose duration is unknown. Shared by the add-audio and generate-music
 * paths; callers apply their own empty-sequence floor (`|| 30`).
 */
export function sumShotDurationsSeconds(
  shots: ReadonlyArray<Pick<Shot, 'durationMs' | 'metadata'>>
): number {
  return shots.reduce((sum, shot) => {
    const seconds = shot.durationMs
      ? shot.durationMs / 1000
      : (shot.metadata?.metadata?.durationSeconds ?? 10);
    return sum + seconds;
  }, 0);
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
  .inputValidator(
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
      if (!sequence.musicPrompt || !sequence.musicTags) {
        throw new Error(
          'Generate music once before adding another audio model'
        );
      }
      const allShots = await scopedDb.shots.listBySequence(sequence.id);
      const totalDuration = sumShotDurationsSeconds(allShots) || 30;

      await requireCredits(scopedDb, estimateAudioCost(model, totalDuration), {
        errorMessage: 'Insufficient credits to add this audio model',
      });

      await scopedDb.sequenceVariants.upsertMusicPrimary({
        sequenceId: sequence.id,
        model,
        prompt: sequence.musicPrompt,
        tags: sequence.musicTags,
        durationSeconds: Math.round(totalDuration),
        status: 'pending',
      });

      const musicInput = buildAddAudioMusicInput({
        baseCtx,
        prompt: sequence.musicPrompt,
        tags: sequence.musicTags,
        durationSeconds: totalDuration,
        model,
      });
      try {
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
            prompt: sequence.musicPrompt,
            tags: sequence.musicTags,
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
      // Project each shot's anchor-frame image surface (#989) so eligibility and
      // the per-shot `imageUrl` read below keep using the legacy field names.
      await scopedDb.shots.ensureAnchorFrames(allShots);
      const anchorsByShot = new Map(
        (await scopedDb.frames.listAnchorsBySequence(sequence.id)).map((fr) => [
          fr.shotId,
          fr,
        ])
      );
      const shotsWithImage = allShots.flatMap((shot) => {
        const frame = anchorsByShot.get(shot.id);
        return frame ? [projectShotWithImage(shot, frame)] : [];
      });
      const eligible = selectEligibleVideoShots(shotsWithImage);
      if (eligible.length === 0) {
        throw new Error('No shots have a completed image to animate yet');
      }

      await requireCredits(
        scopedDb,
        multiplyMicros(estimateVideoCost(model, 5), eligible.length),
        { errorMessage: 'Insufficient credits to add this video model' }
      );

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
        includeMusic: false,
        videoModels: [model],
        // Adding a video model lands as an alternate only — never the primary
        // video. Promote later with "Set". (#547)
        variantOnly: true,
        shots: eligible.map((f) => {
          const selectedMotion = selectedMotionByShot.get(f.id);
          // Prefer the selected version's structured prompt; fall back to the
          // `shot.motionPrompt` mirror for legacy shots with no version pointer
          // (#713) so they still animate with their existing motion prompt.
          const motionPrompt = selectedMotion
            ? motionPromptFromVersion(selectedMotion)
            : f.motionPrompt
              ? { fullPrompt: f.motionPrompt, dialogue: null, audio: null }
              : undefined;
          return {
            shotId: f.id,
            imageUrl: f.thumbnailUrl ?? '',
            prompt: resolveMotionPrompt(
              {
                motionPrompt: motionPrompt ?? null,
                characterTags: f.metadata?.continuity?.characterTags,
                description: f.description,
              },
              model
            ),
            model,
            motionPrompt,
            characterTags: f.metadata?.continuity?.characterTags,
            duration: f.durationMs
              ? f.durationMs / 1000
              : (f.metadata?.metadata?.durationSeconds ?? 3),
            aspectRatio: sequence.aspectRatio,
          };
        }),
      };
      try {
        const workflowRunId = await triggerWorkflow(
          '/motion-batch',
          workflowInput,
          {
            deduplicationId: `add-video-${sequence.id}-${model}-${Date.now()}`,
            label: buildWorkflowLabel(sequence.id),
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
    // The image prompt lives on the anchor frame now (#989); load frames so each
    // shot's stored prompt can seed its `/image` run.
    await scopedDb.shots.ensureAnchorFrames(allShots);
    const imageFramesById = new Map(
      (await scopedDb.frames.listBySequence(sequence.id)).map((fr) => [
        fr.id,
        fr,
      ])
    );
    const [characters, locations, elements] = await Promise.all([
      scopedDb.characters.listWithSheets(sequence.id),
      scopedDb.sequenceLocations.listWithReferences(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
    ]);

    const inputs: NonNullable<
      Awaited<ReturnType<typeof buildShotImageWorkflowInput>>
    >[] = [];
    for (const f of allShots) {
      const input = await buildShotImageWorkflowInput({
        shot: f,
        model,
        userId: user.id,
        teamId: sequence.teamId,
        sequenceId: sequence.id,
        aspectRatio: sequence.aspectRatio,
        characters,
        locations,
        elements,
        imagePrompt: imageFramesById.get(f.id)?.imagePrompt ?? null,
        // Adding a model never repoints the primary — it lands as an alternate
        // variant only. Promote later with "Set". (#547)
        variantOnly: true,
      });
      if (input) inputs.push(input);
    }
    if (inputs.length === 0) {
      throw new Error('No shots have a prompt to generate from');
    }

    await requireCredits(
      scopedDb,
      multiplyMicros(
        estimateImageCost(model, sequence.aspectRatio, 1),
        inputs.length
      ),
      { errorMessage: 'Insufficient credits to add this image model' }
    );

    // Trigger one image workflow per shot. A single shot's trigger failure
    // shouldn't abort the rest of the batch — mark that shot's pending row
    // failed (so it doesn't block a future re-add) and continue. Only throw if
    // every shot failed to trigger.
    // No pre-seeded variant row: the IMAGE_WORKFLOW (variantOnly) appends the
    // in-flight `frame_variants` 'model' version itself in set-generating-status,
    // and its onFailure marks it failed — so there's nothing to pre-write here.
    let workflowRunId = '';
    let triggered = 0;
    for (const input of inputs) {
      try {
        workflowRunId = await triggerWorkflow('/image', input, {
          deduplicationId: `add-image-${input.shotId}-${model}-${Date.now()}`,
          label: buildWorkflowLabel(sequence.id),
        });
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
  .inputValidator(
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
      // Resolve each frame's owning shot — frame ids are NOT shot ids (#989) —
      // so the now-stale video reset targets the right shot row.
      const shotIdByFrame = new Map(
        (await scopedDb.frames.getByIds([...latestByFrame.keys()])).map((f) => [
          f.id,
          f.shotId,
        ])
      );
      let imageCount = 0;
      for (const [frameId, version] of latestByFrame) {
        await scopedDb.frameVariants.select(frameId, version.id, {
          actorId: user.id,
        });
        const ownerShotId = shotIdByFrame.get(frameId);
        if (ownerShotId) {
          await scopedDb.shots.update(
            ownerShotId,
            {
              videoUrl: null,
              videoPath: null,
              videoStatus: 'pending',
              videoWorkflowRunId: null,
              videoGeneratedAt: null,
              videoError: null,
            },
            { throwOnMissing: false }
          );
        }
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
 * Trigger sequence-level music generation.
 * Uses pre-generated prompt/tags when available, otherwise builds from shot audio specs.
 */
export const generateMusicFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
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
      label: buildWorkflowLabel(sequence.id),
    });

    return { success: true };
  });
