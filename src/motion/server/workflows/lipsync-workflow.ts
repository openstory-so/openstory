/**
 * Lip-sync a finished clip (#2263).
 *
 * The trigger snapshots the selected video URL, the dialogue file, and a
 * manifest that keeps the source render's picture pointers and restamps
 * this shot's audio. This run opens its own video version (`source:
 * 'lipsync'`) under the video model that rendered the clip, and promotes
 * it through the same claim as a render. The underlying render row is
 * left alone.
 *
 *   1. check-credits — the $8/min card. BYOK fal skips the balance check.
 *   2. set-generating — append the claim row. A deleted shot stops here.
 *   3. submit — `fal-ai/sync-lipsync/v3`, `sync_mode: cut_off`.
 *   4. poll batches — 30s inside a step, checkpoint between.
 *   5. upload — provider URL into R2. Only `{ url, path }` is checkpointed.
 *   6. persist — complete, promote if this run still holds the claim, charge.
 */

import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import { requireCredits } from '@/billing/server/preflight';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/models/server/fal-deadline-fetch';
import { extractFalErrorMessage } from '@/models/fal-error';
import { isValidImageToVideoModel } from '@/models/models';
import { isFalValidationError } from '@/studio/server/workflows/asset-generation-workflow';
import {
  LIPSYNC_FAL_ENDPOINT,
  LIPSYNC_MODEL_ID,
  estimateLipsyncCost,
  lipsyncFalInput,
  lipsyncResultIsTerminal,
} from '@/motion/lipsync';
import { uploadVideoToStorage } from '@/motion/server/video-storage';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { VideoVariant } from '@/platform/server/db/schema';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import { computeVideoManifestInputHash } from '@/shots/input-hash';
import { ensureExternallyFetchableUrl } from '@/platform/server/storage/external-url';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type { OpenStoryFailureContext } from '@/platform/server/workflow/base-workflow';
import type { LipsyncWorkflowInput } from '@/platform/server/workflow/types';
import { fal } from '@fal-ai/client';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'lipsync']);

const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_BATCHES = 60;

type OpenedVersion = {
  shotDeleted: boolean;
  videoVersionId: string | null;
};

async function configureFal(
  scopedDb: WorkflowScopedDb
): Promise<{ usedOwnKey: boolean; key: string }> {
  const keyInfo = await scopedDb.credentials.resolveKey('fal');
  fal.config({
    credentials: keyInfo.key,
    fetch: createDeadlineFetch(FAL_REQUEST_TIMEOUT_MS, 'Lip-sync request'),
  });
  return { usedOwnKey: keyInfo.source === 'organization', key: keyInfo.key };
}

function providerVideoUrl(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null;
  const video = 'video' in data ? data.video : null;
  if (video === null || typeof video !== 'object' || !('url' in video)) {
    return null;
  }
  return typeof video.url === 'string' ? video.url : null;
}

async function persistLipsyncFailure(opts: {
  scopedDb: WorkflowScopedDb;
  shotId: string;
  videoModel: string | undefined;
  error: string;
  workflowRunId: string;
}): Promise<void> {
  const { scopedDb, shotId, error, workflowRunId } = opts;
  const shot = await scopedDb.liveRead.shots.getById(shotId);
  if (shot?.renderSegmentId) {
    const segment = await scopedDb.liveRead.renderSegments.getById(
      shot.renderSegmentId
    );
    if (segment?.pendingPromoteVersionId) {
      const pending = await scopedDb.claims.videoVariants.getById(
        segment.pendingPromoteVersionId
      );
      if (pending?.workflowRunId === workflowRunId) {
        await scopedDb.renderSegments.clearPendingPromoteVersionIdIf(
          shot.renderSegmentId,
          pending.id
        );
      }
    }
  }
  const marked = await scopedDb.videoVariants.markFailedByWorkflowRun(
    workflowRunId,
    error
  );
  if (
    marked === 0 &&
    shot?.renderSegmentId &&
    isValidImageToVideoModel(opts.videoModel)
  ) {
    await scopedDb.videoVariants.appendVersion({
      renderSegmentId: shot.renderSegmentId,
      sequenceId: shot.sequenceId,
      model: opts.videoModel,
      source: 'lipsync',
      manifest: [],
      status: 'failed',
      error,
      workflowRunId,
      isPrimary: true,
    });
  }
  if (!shot?.sequenceId) return;
  try {
    await getGenerationChannel(shot.sequenceId).emit(
      'generation.video:progress',
      {
        shotId,
        status: 'failed',
        ...(isValidImageToVideoModel(opts.videoModel)
          ? { model: opts.videoModel }
          : {}),
        error,
      }
    );
  } catch (emitError) {
    logger.error('[LipsyncWorkflow] failed to emit failure', {
      err: emitError,
    });
  }
}

export class LipsyncWorkflow extends OpenStoryWorkflowEntrypoint<LipsyncWorkflowInput> {
  protected override readonly failureLabel = 'Lip-sync';

  protected override async onFailure(
    failure: OpenStoryFailureContext<LipsyncWorkflowInput>
  ): Promise<void> {
    await persistLipsyncFailure({
      scopedDb: failure.scopedDb,
      shotId: failure.event.payload.shotId,
      videoModel: failure.event.payload.videoModel,
      error: failure.error,
      workflowRunId: failure.event.instanceId,
    });
  }

  protected override async runImpl(
    event: Readonly<WorkflowEvent<LipsyncWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ videoUrl: string | null }> {
    const input = event.payload;
    const workflowRunId = event.instanceId;
    if (!isValidImageToVideoModel(input.videoModel)) {
      throw new NonRetryableError(
        'videoModel is required to lip-sync this clip',
        'WorkflowValidationError'
      );
    }
    const videoModel = input.videoModel;
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
      throw new NonRetryableError(
        'durationSeconds is required to lip-sync this clip',
        'WorkflowValidationError'
      );
    }
    const cost = estimateLipsyncCost(input.durationSeconds);

    const { usedOwnKey } = await step.do('check-credits', async () => {
      const falKey = await scopedDb.credentials.resolveKey('fal');
      const ownKey = falKey.source === 'organization';
      if (!ownKey) {
        await requireCredits(scopedDb.liveRead, cost, {
          errorMessage: 'Insufficient credits for lip-sync',
          reservationId: input.reservationId,
        });
      }
      return { usedOwnKey: ownKey };
    });

    const opened = await step.do(
      'set-generating',
      async (): Promise<OpenedVersion> => {
        const shot = await scopedDb.liveRead.shots.getById(input.shotId);
        if (!shot) return { shotDeleted: true, videoVersionId: null };
        const inputHash = await computeVideoManifestInputHash(
          input.manifest,
          videoModel
        );
        const version: VideoVariant =
          await scopedDb.videoVariants.appendVersion({
            renderSegmentId: input.renderSegmentId,
            sequenceId: input.sequenceId,
            model: videoModel,
            source: 'lipsync',
            resolution: input.resolution ?? undefined,
            manifest: input.manifest,
            inputHash,
            status: 'generating',
            workflowRunId,
            isPrimary: true,
          });
        await scopedDb.renderSegments.setPendingPromoteVersionId(
          input.renderSegmentId,
          version.id
        );
        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              model: videoModel,
            }
          );
        } catch (emitError) {
          logger.error('[LipsyncWorkflow] failed to emit generating', {
            err: emitError,
          });
        }
        return { shotDeleted: false, videoVersionId: version.id };
      }
    );
    if (opened.shotDeleted || !opened.videoVersionId) {
      return { videoUrl: null };
    }
    const videoVersionId = opened.videoVersionId;

    const { requestId } = await step.do('submit-lipsync', async () => {
      const { key } = await configureFal(scopedDb);
      const [videoUrl, audioUrl] = await Promise.all([
        ensureExternallyFetchableUrl(input.videoUrl, key),
        ensureExternallyFetchableUrl(input.audioUrl, key),
      ]);
      try {
        const { request_id } = await fal.queue.submit(LIPSYNC_FAL_ENDPOINT, {
          input: lipsyncFalInput(videoUrl, audioUrl),
        });
        return { requestId: request_id };
      } catch (error) {
        if (isFalValidationError(error)) {
          throw new NonRetryableError(
            `Lip-sync rejected the clip (422): ${extractFalErrorMessage(error)}`
          );
        }
        throw error;
      }
    });

    let completed = false;
    for (let batch = 0; batch < MAX_BATCHES && !completed; batch++) {
      if (batch > 0) await step.sleep(`lipsync-poll-wait-${batch}`, 1);
      completed = await step.do(`lipsync-poll-batch-${batch}`, async () => {
        await configureFal(scopedDb);
        const deadline = Date.now() + POLL_BATCH_DURATION_MS;
        while (Date.now() < deadline) {
          const status = await fal.queue.status(LIPSYNC_FAL_ENDPOINT, {
            requestId,
            logs: false,
          });
          if (status.status === 'COMPLETED') return true;
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        return false;
      });
    }
    if (!completed) {
      throw new Error(
        `Lip-sync timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    const providerUrl = await step.do('fetch-lipsync', async () => {
      await configureFal(scopedDb);
      try {
        const result = await fal.queue.result(LIPSYNC_FAL_ENDPOINT, {
          requestId,
        });
        const url = providerVideoUrl(result.data);
        if (!url) {
          throw new NonRetryableError('Lip-sync returned no video.');
        }
        return url;
      } catch (error) {
        if (error instanceof NonRetryableError) throw error;
        if (!lipsyncResultIsTerminal(error)) throw error;
        throw new NonRetryableError(
          `Lip-sync failed: ${extractFalErrorMessage(error)}`
        );
      }
    });

    const stored = await step.do('upload-lipsync', async () => {
      const uploaded = await uploadVideoToStorage({
        videoUrl: providerUrl,
        organizationId: input.organizationId,
        sequenceId: input.sequenceId,
        shotId: input.shotId,
        sequenceTitle: input.sequenceTitle,
        sceneTitle: input.sceneTitle,
      });
      if (!uploaded.success) {
        throw new Error(uploaded.error);
      }
      return { url: uploaded.url, path: uploaded.path };
    });

    return step.do('persist-lipsync', async () => {
      const row = await scopedDb.videoVariants.completeIfLive(videoVersionId, {
        url: stored.url,
        storagePath: stored.path,
        generatedAt: new Date(),
        error: null,
      });
      if (!row) return { videoUrl: null };

      await scopedDb.sequenceEvents.record({
        sequenceId: input.sequenceId,
        actorId: input.userId,
        kind: 'video.rendered',
        targetType: 'shot',
        targetId: input.shotId,
        summary: 'Lip-synced the clip',
        data: {
          versionId: videoVersionId,
          model: videoModel,
          sceneId: input.sceneId,
        },
      });

      const shot = await scopedDb.liveRead.shots.getById(input.shotId);
      const promoted = shot
        ? await scopedDb.videoVariants.selectIfPendingPromoteIs(
            input.shotId,
            videoVersionId,
            { actorId: input.userId }
          )
        : null;

      await deductWorkflowCredits({
        scopedDb,
        costMicros: cost,
        usedOwnKey,
        description: 'Lip-sync',
        idempotencyKey: `${workflowRunId}:lipsync`,
        workflowName: 'LipsyncWorkflow',
        reservationId: input.reservationId,
        metadata: { shotId: input.shotId, model: LIPSYNC_MODEL_ID },
      });

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.video:progress',
          {
            shotId: input.shotId,
            status: 'completed',
            videoUrl: stored.url,
            model: videoModel,
            ...(promoted ? {} : { variantOnly: true }),
          }
        );
      } catch (emitError) {
        logger.error('[LipsyncWorkflow] failed to emit completion', {
          err: emitError,
        });
      }
      return { videoUrl: stored.url };
    });
  }
}
