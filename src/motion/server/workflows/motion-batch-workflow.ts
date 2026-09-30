/**
 * The `motionBatchWorkflow` durable workflow.
 *
 * Spawns one `MOTION_WORKFLOW` child per packed generation (and model);
 * leftover / Grok jobs stay 1:1. Optional `MUSIC_WORKFLOW` via Pattern 3.
 * There is no merge step — playback is the live canvas stitch; the
 * downloadable MP4 is `SequenceExportWorkflow`.
 *
 * Fan-out: `Promise.all` on spawn (the parent blocks until every child has
 * been queued, so a transient spawn failure surfaces as a workflow error
 * rather than a silently-skipped child), `Promise.allSettled` on await so a
 * single bad shot doesn't kill the rest of the batch.
 */

import {
  arkAssetIdentities,
  bytePlusAssetSlots,
} from '@/models/server/byteplus-asset-pool';
import { reportBytePlusAssetPool } from '@/models/server/byteplus-observability';
import { isBytePlusAssetsConfigured } from '@/models/server/byteplus-config';
import { arkStillsToRegister } from '@/motion/server/motion-generation';
import { isNativeBytePlusVideoModel } from '@/models/models';
import { resolveAudioModels } from '@/models/resolve-audio-models';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';

import { buildMotionRender } from '@/motion/server/build-motion-render';
import { getGenerationChannel } from '@/platform/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import {
  attachRecordedClips,
  missingDialogueAudioShotIds,
} from './motion-batch-jobs';
import type {
  BatchMotionMusicWorkflowInput,
  DialogueAudioWorkflowInput,
  DialogueAudioWorkflowResult,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicWorkflowInput,
  MusicWorkflowResult,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-batch']);

/** Admission re-checks before the batch fans out regardless. */
const POOL_ADMISSION_ATTEMPTS = 5;

/** Long enough for a sibling batch's shots to finish and release. */
const POOL_ADMISSION_WAIT = '2 minutes';

type MotionBatchWorkflowResult = {
  sequenceId: string;
};

export class MotionBatchWorkflow extends OpenStoryWorkflowEntrypoint<BatchMotionMusicWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>,
    step: WorkflowStep,
    // Fan-out uses workflow bindings, not direct DB access; the merge steps
    // that read shots were removed (browser-side merge). Kept for signature
    // parity with the abstract runImpl.
    scopedDb: WorkflowScopedDb
  ): Promise<MotionBatchWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { sequenceId, includeMusic } = input;

    if (!sequenceId) {
      throw new WorkflowValidationError('sequenceId is required');
    }
    if (!input.shots.length) {
      throw new WorkflowValidationError('At least one shot is required');
    }
    if (includeMusic && !input.music) {
      throw new WorkflowValidationError(
        'music config is required when includeMusic is true'
      );
    }
    // Every shot needs either a start frame or the reference-only flag. Callers
    // all pre-filter, but until reference-only made `imageUrl` optional the
    // only thing catching an empty one was the per-shot child — after it had
    // been spawned, credit-checked, and had a `video_variants` row opened.
    // Assert it here instead, where it costs nothing and names the shot.
    const unrenderable = input.shots.filter(
      (shot) => !shot.imageUrl?.trim() && !shot.referenceOnly
    );
    if (unrenderable.length > 0) {
      throw new WorkflowValidationError(
        `Shots have no start frame and are not reference-only: ${unrenderable
          .map((shot) => shot.shotId)
          .join(', ')}`
      );
    }

    // Step 0: BytePlus ACR admission (#1361). Face-bearing stills a Seedance
    // shot sends — start frame and character sheets — have to be registered
    // as `asset://`, and those slots are per BytePlus ACCOUNT, not per run.
    // 20 children that each discover slot 51 for themselves is 20 wasted
    // `CreateAsset` attempts (then failed shots), so count the batch against
    // the pool first and let it drain.
    //
    // Reads through `scopedDb.liveRead.bytePlusAssets.getAdmission` (the live
    // hatch): occupancy is shared across teams and cannot be snapshotted at
    // trigger — a run that froze it would evict slots another team leased
    // minutes later.
    await this.awaitBytePlusPoolAdmission(input, step, scopedDb);

    // Step 0b: record dialogue ONCE PER SCENE (#1657). The parent must not
    // fan out motion until every voiced shot has a matching take; a failed or
    // partial scene recording blocks the batch below.
    const shots = await this.recordScenesOnce(input, step, parentInstanceId);
    const missingDialogueShotIds = missingDialogueAudioShotIds(shots);
    if (missingDialogueShotIds.length > 0) {
      throw new WorkflowValidationError(
        `Dialogue audio was not generated for shot${missingDialogueShotIds.length === 1 ? '' : 's'} ${missingDialogueShotIds.join(', ')}; motion is blocked.`
      );
    }

    // Step 1: Fan out motion workflows + optional music workflow in parallel.
    // Multi-model video (#545/#1510): one MOTION_WORKFLOW child per packed
    // generation (and model); leftover / Grok jobs stay 1:1. See
    // `buildMotionJobs` for the resolution/dedupe rules. The first model is
    // primary (its output also lands in the legacy `shots.video*` columns);
    // the rest are alternates in `shot_variants`. Pattern 3 spawns + awaits
    // each child via `spawnAndAwaitChild`; Promise.allSettled lets a single
    // failing (shot, model) not poison the rest of the batch.
    const motionJobs = buildMotionRender({ ...input, shots });
    const motionAwaits = motionJobs.map(({ input: motionBody, shotIndex }) => {
      const { model, shotId } = motionBody;
      return spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
        step,
        {
          binding: this.env.MOTION_WORKFLOW,
          parentBindingName: 'MOTION_BATCH_WORKFLOW',
          parentInstanceId,
          // The model token keeps sibling-model children from colliding on the
          // global CF instance id (mirrors shot-images' childId scheme).
          childId: `motion:${sequenceId}:${shotId}:${model}`,
          childPayload: motionBody,
          spawnStepName: `spawn-motion-${shotIndex}-${model}`,
          awaitStepName: `await-motion-${shotIndex}-${model}`,
          // Must exceed the child's own budget: motion polls for up to 30
          // minutes (MAX_BATCHES in motion-workflow.ts), and a BytePlus shot
          // first ingests its stills — up to 20 minutes waiting on another
          // run's create (CLAIM_RETRIES) plus the governor's 15-minute
          // CreateAsset queue — then submit/compress/persist steps and notify
          // lag under a burst.
          timeout: '90 minutes',
        }
      );
    });

    // Multi-model audio (#546): one MUSIC_WORKFLOW child per selected model,
    // each reusing the same prompt/tags/duration and opening its own row in
    // sequence_music_variants. Only the first model is primary — it alone
    // claims the sequence's track pointer (#1115); the rest land as their own
    // rows (see `isPrimary` below).
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
          // dedupes); only it claims the sequence's track pointer.
          isPrimary: index === 0,
          reservationId: input.reservationId,
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

    // Log per-shot motion failures for visibility; we don't throw here. Like
    // the rest of the batch surface (shot-images) this allSettles and relies
    // on the collect step below to validate that we have something mergeable.
    for (let i = 0; i < motionResults.length; i++) {
      const r = motionResults[i];
      if (r?.status === 'rejected') {
        const job = motionJobs[i];
        // Include the reason in the message itself — structured `err` fields
        // don't reliably survive into the log body (the June 7 run produced
        // bare "Motion failed for shot …:" lines with no cause attached).
        logger.warn(
          `[MotionBatchWorkflow:cf] Motion failed for shot ${job?.input.shotId ?? '(unknown)'} model ${job?.input.model ?? '(unknown)'}: ${String(r.reason)}`,
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

    // Playback is the live canvas stitch; the downloadable MP4 is a
    // separate SequenceExportWorkflow. No merge step here.
    const reservationId = input.reservationId;
    if (reservationId) {
      await step.do('zero-reservation', async () => {
        await scopedDb.billing.zeroReservation(reservationId);
      });
    }
    return { sequenceId };
  }

  /**
   * Hold the fan-out until this batch's distinct stills fit the ACR pool.
   *
   * Bounded on purpose: waiting forever would hang a generation. Overshooting
   * is fatal — each child claim fails immediately on a full leased pool
   * (`NonRetryableError`); there is no public-URL or fal fallback. A still
   * another run is creating waits ~20 minutes (40 × 30s) then fails if that
   * create never lands. A BYOK-fal team never touches the pool but is not
   * excluded here (that needs a credential read for a check that only ever
   * costs a `count(*)`); it can be delayed by other teams' traffic, which the
   * `deferred` event will show if it ever matters.
   */
  /**
   * Record every scene in `input.dialogueRecording` once, then return the
   * shots with their new clips attached.
   *
   * A failed scene remains without clips. The caller validates every voiced
   * shot before fan-out and blocks motion for any shot without a matching take.
   */
  private async recordScenesOnce(
    input: BatchMotionMusicWorkflowInput,
    step: WorkflowStep,
    parentInstanceId: string
  ): Promise<BatchMotionMusicWorkflowInput['shots']> {
    const recording = input.dialogueRecording;
    const sequenceId = input.sequenceId;
    if (!recording || recording.scenes.length === 0 || !sequenceId) {
      return input.shots;
    }

    const result = await spawnAndAwaitChild<
      DialogueAudioWorkflowInput,
      DialogueAudioWorkflowResult
    >(step, {
      binding: this.env.DIALOGUE_AUDIO_WORKFLOW,
      parentBindingName: 'MOTION_BATCH_WORKFLOW',
      parentInstanceId,
      childId: `dialogue-audio:${sequenceId}:${parentInstanceId}`,
      childPayload: {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        reservationId: input.reservationId,
        scenes: recording.scenes,
        minDurationSeconds: recording.minDurationSeconds,
        maxDurationSeconds: recording.maxDurationSeconds,
        analysisModelId: recording.analysisModelId,
      },
      spawnStepName: 'spawn-dialogue-audio',
      awaitStepName: 'await-dialogue-audio',
      timeout: '60 minutes',
    });

    return attachRecordedClips(input.shots, result.clipsByShotId);
  }

  private async awaitBytePlusPoolAdmission(
    input: BatchMotionMusicWorkflowInput,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<void> {
    const models = input.videoModels ?? input.shots.map((shot) => shot.model);
    if (
      !isBytePlusAssetsConfigured() ||
      !models.some((model) => model && isNativeBytePlusVideoModel(model))
    ) {
      return;
    }
    // Only the stills ingest will CreateAsset for (#1756): counting every
    // reference URL budgeted location and element sheets that never take a
    // slot, and parked batches behind a pool that had room for them.
    const stills = arkStillsToRegister(input.shots);
    if (!stills.length) return;

    for (let attempt = 0; attempt < POOL_ADMISSION_ATTEMPTS; attempt++) {
      const admission = await step.do(
        `byteplus-pool-admission-${attempt}`,
        async () =>
          scopedDb.liveRead.bytePlusAssets.getAdmission(
            await arkAssetIdentities(stills),
            bytePlusAssetSlots()
          )
      );
      if (admission.fits) return;
      reportBytePlusAssetPool({ outcome: 'deferred' });
      logger.warn(
        `[MotionBatchWorkflow:cf] BytePlus asset pool cannot fit ${admission.needed} new stills (free ${admission.free}, evictable ${admission.evictable})`
      );
      if (attempt < POOL_ADMISSION_ATTEMPTS - 1) {
        await step.sleep(`byteplus-pool-wait-${attempt}`, POOL_ADMISSION_WAIT);
      }
    }
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    if (input.reservationId) {
      try {
        await scopedDb.billing.zeroReservation(input.reservationId);
      } catch (releaseError) {
        logger.error(
          `[MotionBatchWorkflow:cf] Failed to zero reservation ${input.reservationId}:`,
          { err: releaseError }
        );
      }
    }

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
