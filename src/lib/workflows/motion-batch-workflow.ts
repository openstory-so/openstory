/**
 * Cloudflare Workflows port of `motionBatchWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-batch-workflow.ts`)
 * step for step — same control flow, same side effects. Differences (all
 * infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` and the run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - Each `context.invoke(...)` becomes a Pattern 3 `spawnAndAwaitChild`
 *     against the relevant binding (MOTION_WORKFLOW × N frames, optional
 *     MUSIC_WORKFLOW). There is no server-side video merge step — playback
 *     and the final MP4 are produced client-side (Mediabunny browser export).
 *   - Fan-out: `Promise.all` on spawn (parents block until every child has
 *     been queued so a transient spawn failure surfaces as a workflow error
 *     rather than a silently-skipped child), `Promise.allSettled` on await
 *     so a single bad frame doesn't kill the rest of the batch. */

import {
  DEFAULT_VIDEO_MODEL,
  type ImageToVideoModel,
  videoModelMaxDurationSeconds,
} from '@/lib/ai/models';
import { resolveAudioModels } from '@/lib/ai/resolve-audio-models';
import { dbSceneId, type DbSceneId } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import { assembleMultiShotMotion } from '@/lib/motion/assemble-multishot-motion';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  groupShotsForRender,
  motionBatchTotalFailureMessage,
  type RenderShot,
} from '@/lib/workflows/motion-batch-jobs';
import type {
  BatchMotionMusicWorkflowInput,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicWorkflowInput,
  MusicWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

/** One shot in the batch payload — the element type of the input `shots[]`. */
type BatchShot = BatchMotionMusicWorkflowInput['shots'][number];

const logger = getLogger(['openstory', 'workflow', 'motion-batch']);

type MotionBatchWorkflowResult = {
  sequenceId: string;
};

export class MotionBatchWorkflow extends OpenStoryWorkflowEntrypoint<BatchMotionMusicWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>,
    step: WorkflowStep,
    // Fan-out uses workflow bindings, not direct DB access; the merge steps
    // that read frames were removed (browser-side merge). Kept for signature
    // parity with the abstract runImpl.
    _scopedDb: ScopedDb
  ): Promise<MotionBatchWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { sequenceId, includeMusic } = input;

    if (!sequenceId) {
      throw new WorkflowValidationError('sequenceId is required');
    }
    if (!input.shots.length) {
      throw new WorkflowValidationError('At least one frame is required');
    }
    if (includeMusic && !input.music) {
      throw new WorkflowValidationError(
        'music config is required when includeMusic is true'
      );
    }

    // Step 1: Fan out motion workflows + optional music workflow in parallel.
    //
    // Multi-model video (#545): one fan-out per model. Within each model we
    // GROUP the shots by their real `scenes.id` ULID (#910): a multi-shot scene
    // on a multi-shot-capable model renders in ONE call (writing `scenes.video*`
    // + `renderStrategy='multi-shot'`); every other case stays per-shot (the
    // #545 behaviour — first model primary → legacy `frames.video*`, the rest
    // alternates). Pattern 3 spawns + awaits each child; Promise.allSettled lets
    // a single failing unit not poison the rest of the batch.
    const models: ImageToVideoModel[] =
      input.videoModels && input.videoModels.length > 0
        ? [...new Set(input.videoModels)]
        : [];

    const motionAwaits: Array<Promise<MotionWorkflowResult>> = [];
    const motionJobLabels: string[] = [];

    // Per-shot model fallback when no top-level videoModels were given.
    const modelForShot = (shot: BatchShot): ImageToVideoModel =>
      shot.model ?? DEFAULT_VIDEO_MODEL;

    // The effective per-model lists: top-level models apply to every shot;
    // otherwise each shot uses its own model (single-model paths).
    const perModelShots: Array<{
      model: ImageToVideoModel;
      shots: BatchShot[];
    }> =
      models.length > 0
        ? models.map((model) => ({ model, shots: [...input.shots] }))
        : [...new Set(input.shots.map(modelForShot))].map((model) => ({
            model,
            shots: input.shots.filter((s) => modelForShot(s) === model),
          }));

    for (const { model, shots } of perModelShots) {
      // Group this model's shots by real scene ULID; pick strategy from the
      // model's capability profile. Shots with no `sceneDbId` (legacy / manual)
      // group as loose per-shot units (groupShotsForRender handles this).
      const renderShots: RenderShot<BatchShot>[] = shots.map((shot) => ({
        ...shot,
        sceneDbId: shot.sceneDbId ?? null,
        shotNumber: shot.shotNumber ?? 1,
      }));
      const units = groupShotsForRender(renderShots, model);

      for (const unit of units) {
        if (unit.strategy === 'multi-shot') {
          // ONE call rendering the whole scene's shot list.
          const ordered = unit.shots;
          const anchor = ordered[0];
          if (!anchor) continue;

          const assembly = assembleMultiShotMotion({
            model,
            shots: ordered.map((s) => ({
              shotNumber: s.shotNumber,
              // Structured prompt is required for multi-shot weave; fall back to
              // the pre-assembled string wrapped as a bare prompt if absent.
              motionPrompt: s.motionPrompt ?? {
                fullPrompt: s.prompt,
                components: {
                  cameraMovement: '',
                  startPosition: '',
                  endPosition: '',
                  durationSeconds: s.duration ?? 5,
                  speed: 'smooth',
                  smoothness: 'smooth',
                  subjectTracking: '',
                  equipment: '',
                },
                parameters: {
                  durationSeconds: s.duration ?? 5,
                  fps: 24,
                  motionAmount: 'medium',
                  cameraControl: { pan: 0, tilt: 0, zoom: 1, movement: '' },
                },
                dialogue: null,
                audio: null,
              },
              durationSeconds: s.duration ?? 5,
            })),
            characterTags: anchor.characterTags,
            maxDurationSeconds: videoModelMaxDurationSeconds(model),
          });
          // assembly is non-null: groupShotsForRender only yields a multi-shot
          // unit for a multi-shot-capable model.
          if (!assembly) continue;

          const sceneId: DbSceneId = dbSceneId(unit.sceneDbId);
          const motionBody: MotionWorkflowInput = {
            userId: input.userId,
            teamId: input.teamId,
            // Anchor shot 1 drives the i2v start frame + realtime emits.
            shotId: anchor.shotId,
            sceneId,
            sequenceId,
            imageUrl: anchor.imageUrl,
            // prose-labels models carry the weave in `prompt`; multi-prompt-array
            // models carry it in `multiPrompt` (and `prompt` is unused).
            prompt: assembly.syntax === 'prose-labels' ? assembly.prompt : '',
            multiPrompt:
              assembly.syntax === 'multi-prompt-array'
                ? assembly.multiPrompt
                : undefined,
            // Advisory: last shot's start frame as the end keyframe; shots 2..N
            // start frames as reference elements (Kling).
            endImageUrl: ordered[ordered.length - 1]?.imageUrl,
            elementImageUrls: ordered.slice(1).map((s) => s.imageUrl),
            model,
            duration: assembly.totalDurationSeconds,
            aspectRatio: anchor.aspectRatio,
            generateAudio: anchor.generateAudio,
            variantOnly: input.variantOnly,
          };

          motionJobLabels.push(`scene ${unit.sceneDbId} (${model})`);
          motionAwaits.push(
            spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
              step,
              {
                binding: this.env.MOTION_WORKFLOW,
                parentBindingName: 'MOTION_BATCH_WORKFLOW',
                parentInstanceId,
                childId: `motion-scene:${sequenceId}:${unit.sceneDbId}:${model}`,
                childPayload: motionBody,
                spawnStepName: `spawn-motion-scene-${unit.sceneDbId}-${model}`,
                awaitStepName: `await-motion-scene-${unit.sceneDbId}-${model}`,
                timeout: '45 minutes',
              }
            )
          );
          continue;
        }

        // per-shot unit (today's behaviour).
        const shot = unit.shot;
        const prompt = shot.motionPrompt
          ? assembleMotionPrompt({
              motionPrompt: shot.motionPrompt,
              model,
              characterTags: shot.characterTags,
            })
          : shot.prompt;

        const motionBody: MotionWorkflowInput = {
          userId: input.userId,
          teamId: input.teamId,
          shotId: shot.shotId,
          sequenceId,
          imageUrl: shot.imageUrl,
          prompt,
          model,
          duration: shot.duration,
          fps: shot.fps,
          motionBucket: shot.motionBucket,
          aspectRatio: shot.aspectRatio,
          generateAudio: shot.generateAudio,
          userEditedPrompt: shot.userEditedPrompt,
          variantOnly: input.variantOnly,
        };

        motionJobLabels.push(`shot ${shot.shotId} (${model})`);
        motionAwaits.push(
          spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(step, {
            binding: this.env.MOTION_WORKFLOW,
            parentBindingName: 'MOTION_BATCH_WORKFLOW',
            parentInstanceId,
            childId: `motion:${sequenceId}:${shot.shotId}:${model}`,
            childPayload: motionBody,
            spawnStepName: `spawn-motion-${shot.shotId}-${model}`,
            awaitStepName: `await-motion-${shot.shotId}-${model}`,
            timeout: '45 minutes',
          })
        );
      }
    }

    // Multi-model audio (#546): one MUSIC_WORKFLOW child per selected model,
    // each reusing the same prompt/tags/duration and writing its own primary
    // row in sequence_music_variants (keyed by (sequenceId, model)). Only the
    // first model is primary — it alone writes the live `sequences.music*`
    // columns; the rest persist only their variant row (see `isPrimary` below).
    // Falls back to the single `music.model` when no audioModels were threaded.
    const audioModels =
      includeMusic && input.music
        ? resolveAudioModels(input.audioModels, input.music.model)
        : [];

    const musicJobs =
      includeMusic && input.music
        ? audioModels.map((model) => ({ model }))
        : [];

    const musicAwaits = musicJobs.map(({ model }, index) => {
      // input.music is narrowed truthy by musicJobs construction above.
      const music = input.music;
      if (!music) {
        throw new WorkflowValidationError('music config missing for batch');
      }
      return spawnAndAwaitChild<MusicWorkflowInput, MusicWorkflowResult>(step, {
        binding: this.env.MUSIC_WORKFLOW,
        parentBindingName: 'MOTION_BATCH_WORKFLOW',
        parentInstanceId,
        childId: `music:${sequenceId}:${model}`,
        childPayload: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          prompt: music.prompt,
          tags: music.tags,
          duration: music.duration,
          model,
          // audioModels[0] is primary (resolveAudioModels preserves order +
          // dedupes); only it writes the live `sequences.music*` columns.
          isPrimary: index === 0,
        },
        spawnStepName: `spawn-music-${index}-${model}`,
        awaitStepName: `await-music-${index}-${model}`,
        // Same budget as the motion children — queue backlog under a burst
        // applies to audio generation too.
        timeout: '45 minutes',
      });
    });

    const motionResults = await Promise.allSettled(motionAwaits);
    const musicResults = musicAwaits.length
      ? await Promise.allSettled(musicAwaits)
      : null;

    // Log per-shot motion failures for visibility. We allSettle (vs the QStash
    // original's Promise.all) for parity with the rest of the CF batch surface
    // (shot-images) so one bad clip doesn't poison its siblings. Each rejected
    // child has already written its own per-shot `frame_variants.status='failed'`
    // row via onFailure; the aggregate total-failure guard runs after the loops.
    for (let i = 0; i < motionResults.length; i++) {
      const r = motionResults[i];
      if (r?.status === 'rejected') {
        // Include the reason in the message itself — structured `err` fields
        // don't reliably survive into the log body (the June 7 run produced
        // bare "Motion failed for frame …:" lines with no cause attached).
        logger.warn(
          `[MotionBatchWorkflow:cf] Motion failed for ${motionJobLabels[i] ?? '(unknown)'}: ${String(r.reason)}`,
          {
            err: r.reason,
          }
        );
      }
    }
    if (musicResults) {
      for (let i = 0; i < musicResults.length; i++) {
        const m = musicResults[i];
        if (m?.status === 'rejected') {
          logger.warn(
            `[MotionBatchWorkflow:cf] Music generation failed for sequence ${sequenceId} model ${musicJobs[i]?.model ?? '(unknown)'}: ${String(m.reason)}`,
            {
              err: m.reason,
            }
          );
        }
      }
    }

    // Aggregate total-failure guard. There is no server-side merge step
    // (playback + the final MP4 are produced client-side by `<SequencePlayer>` /
    // the Mediabunny browser export), so this workflow is the only place a
    // TOTAL motion failure can be turned into a loud signal. If clips were
    // expected and none rendered, throw so the base class onFailure emits
    // `generation.failed` rather than letting the analyze pipeline report
    // success with zero video. `NonRetryableError` fails the instance
    // immediately — re-running deterministic failures (content rejections, a
    // model outage) would just burn the budget again. Partial success is fine:
    // the rendered clips are usable and each failed shot already shows its row.
    const totalFailure = motionBatchTotalFailureMessage(
      sequenceId,
      motionResults
    );
    if (totalFailure) {
      throw new NonRetryableError(totalFailure);
    }

    // Playback and the final MP4 are produced client-side by
    // `<SequencePlayer>` / the Mediabunny browser export — there is no
    // server-side video merge step (parity with the QStash motion-batch).
    return { sequenceId };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    if (input.sequenceId) {
      try {
        await getGenerationChannel(input.sequenceId).emit('generation.failed', {
          message: error,
        });
      } catch (emitError) {
        logger.error(
          `[MotionBatchWorkflow:cf] Failed to emit generation.failed for sequence ${input.sequenceId}:`,
          {
            err: emitError,
          }
        );
      }
    }

    logger.error(
      `[MotionBatchWorkflow:cf] Failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
