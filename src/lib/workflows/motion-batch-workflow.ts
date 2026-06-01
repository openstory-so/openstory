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

import { DEFAULT_VIDEO_MODEL, type ImageToVideoModel } from '@/lib/ai/models';
import { resolveAudioModels } from '@/lib/ai/resolve-audio-models';
import type { ScopedDb } from '@/lib/db/scoped';
import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  BatchMotionMusicWorkflowInput,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicWorkflowInput,
  MusicWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

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
    if (!input.frames.length) {
      throw new WorkflowValidationError('At least one frame is required');
    }
    if (includeMusic && !input.music) {
      throw new WorkflowValidationError(
        'music config is required when includeMusic is true'
      );
    }

    // Resolve required child bindings up front. Missing bindings are a
    // deployment misconfiguration — fail fast with a non-retryable throw so
    // the dispatcher routes future runs through QStash instead of churning.
    const motionBinding = this.env.MOTION_WORKFLOW;
    if (!motionBinding) {
      throw new WorkflowValidationError(
        '[MotionBatchWorkflow:cf] MOTION_WORKFLOW binding missing on env — check wrangler.jsonc and run `bun cf:typegen`'
      );
    }
    const musicBinding = this.env.MUSIC_WORKFLOW;
    if (includeMusic && !musicBinding) {
      throw new WorkflowValidationError(
        '[MotionBatchWorkflow:cf] MUSIC_WORKFLOW binding missing on env (includeMusic=true) — check wrangler.jsonc and run `bun cf:typegen`'
      );
    }

    // Step 1: Fan out motion workflows + optional music workflow in parallel.
    // Multi-model video (#545): one MOTION_WORKFLOW child per (frame, model)
    // — the motion analog of frame-images' per-(scene, model) fan-out. The
    // top-level `videoModels` (if present) applies to every frame; otherwise
    // each frame falls back to its own `model` (single-model behaviour). The
    // first model is primary (its output also lands in the legacy
    // `frames.video*` columns); the rest are alternates in `frame_variants`.
    // Pattern 3 spawns + awaits each child via `spawnAndAwaitChild`;
    // Promise.allSettled lets a single failing (frame, model) not poison the
    // rest of the batch.
    const topVideoModels =
      input.videoModels && input.videoModels.length > 0
        ? [...new Set(input.videoModels)]
        : null;

    const motionJobs = input.frames.flatMap((frame, frameIndex) => {
      const models: ImageToVideoModel[] =
        topVideoModels ?? (frame.model ? [frame.model] : [DEFAULT_VIDEO_MODEL]);
      return models.map((model) => ({ frame, frameIndex, model }));
    });

    const motionAwaits = motionJobs.map(({ frame, frameIndex, model }) => {
      // Per-model prompt: re-assemble from the structured motion prompt when
      // present so audio-capable models get dialogue/audio sections, falling
      // back to the pre-assembled `prompt` for manual single-model paths.
      const prompt = frame.motionPrompt
        ? assembleMotionPrompt({ motionPrompt: frame.motionPrompt, model })
        : frame.prompt;

      const motionBody: MotionWorkflowInput = {
        userId: input.userId,
        teamId: input.teamId,
        frameId: frame.frameId,
        sequenceId,
        imageUrl: frame.imageUrl,
        prompt,
        model,
        duration: frame.duration,
        fps: frame.fps,
        motionBucket: frame.motionBucket,
        aspectRatio: frame.aspectRatio,
        generateAudio: frame.generateAudio,
        userEditedPrompt: frame.userEditedPrompt,
      };

      return spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
        step,
        {
          binding: motionBinding,
          parentBindingName: 'MOTION_BATCH_WORKFLOW',
          parentInstanceId,
          // The model token keeps sibling-model children from colliding on the
          // global CF instance id (mirrors frame-images' childId scheme).
          childId: `motion:${sequenceId}:${frame.frameId}:${model}`,
          childPayload: motionBody,
          spawnStepName: `spawn-motion-${frameIndex}-${model}`,
          awaitStepName: `await-motion-${frameIndex}-${model}`,
          timeout: '30 minutes',
        }
      );
    });

    // Multi-model audio (#546): one MUSIC_WORKFLOW child per selected model,
    // each reusing the same prompt/tags/duration and writing its own primary
    // row in sequence_music_variants (keyed by (sequenceId, model)). Falls back
    // to the single `music.model` when no audioModels were threaded through.
    const audioModels =
      includeMusic && input.music
        ? resolveAudioModels(input.audioModels, input.music.model)
        : [];

    const musicJobs =
      includeMusic && input.music && musicBinding
        ? audioModels.map((model) => ({ model }))
        : [];

    const musicAwaits = musicJobs.map(({ model }, index) => {
      // input.music is narrowed truthy by musicJobs construction above.
      const music = input.music;
      if (!music || !musicBinding) {
        throw new WorkflowValidationError('music config missing for batch');
      }
      return spawnAndAwaitChild<MusicWorkflowInput, MusicWorkflowResult>(step, {
        binding: musicBinding,
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
        },
        spawnStepName: `spawn-music-${index}-${model}`,
        awaitStepName: `await-music-${index}-${model}`,
        timeout: '30 minutes',
      });
    });

    const motionResults = await Promise.allSettled(motionAwaits);
    const musicResults = musicAwaits.length
      ? await Promise.allSettled(musicAwaits)
      : null;

    // Log per-frame motion failures for visibility; we don't throw here — the
    // QStash original uses Promise.all + a single combined await, but parity
    // with the rest of the CF batch surface (frame-images) is to allSettle
    // and rely on the collect step below to validate that we have something
    // mergeable.
    for (let i = 0; i < motionResults.length; i++) {
      const r = motionResults[i];
      if (r?.status === 'rejected') {
        const job = motionJobs[i];
        logger.warn(
          `[MotionBatchWorkflow:cf] Motion failed for frame ${job?.frame.frameId ?? '(unknown)'} model ${job?.model ?? '(unknown)'}:`,
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
            `[MotionBatchWorkflow:cf] Music generation failed for sequence ${sequenceId} model ${musicJobs[i]?.model ?? '(unknown)'}:`,
            {
              err: m.reason,
            }
          );
        }
      }
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
