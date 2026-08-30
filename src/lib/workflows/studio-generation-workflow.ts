/**
 * Images and Videos (#1274).
 *
 * Sequence models only — `generateImageWithProvider` for stills; for clips
 * `mode` picks the endpoint (see `text-to-video.ts`). Native Grok, BytePlus
 * Ark, and billed fal units work the same way as sequences.
 *
 *   1. set-running
 *   2. generate-image, or submit/poll video (retried on a content flag)
 *   3. capture credits against the run envelope from reported units
 *   4. upload outputs to R2
 *   5. record-provenance
 *   6. persist-result on the reserved `generated_assets` row — last, so a
 *      failure anywhere before it leaves the row `failed`, never
 *      `completed` then flipped
 */

import {
  CONTENT_REJECTION_EVENT,
  clipContentRejectionMessage,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import { ZERO_MICROS } from '@/lib/billing/money';
import {
  deductWorkflowCredits,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { recordProvenance } from '@/lib/compliance/provenance';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { GeneratedAssetOutput } from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { getLogger } from '@/lib/observability/logger';
import {
  pollStudioVideoJob,
  studioVideoCostFromUsage,
  submitStudioVideoJob,
} from '@/lib/studio/studio-video-generation';
import type { StudioCreateInput } from '@/lib/studio/schema';
import { tagStudioReferences } from '@/lib/studio/text-to-video';
import { videoUrlFitsWorkflowCheckpoint } from '@/lib/motion/video-storage';
import { uploadStudioImage, uploadStudioVideo } from '@/lib/studio/upload';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { StudioGenerationWorkflowInput } from '@/lib/workflow/types';
import type { TokenUsage } from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'studio']);

const POLL_BATCH_DURATION_MS = 30_000;
const MAX_BATCHES = 60;
const MAX_MOTION_ATTEMPTS = 3;

type StudioPollOutcome =
  | { kind: 'pending' }
  | { kind: 'completed'; url: string; usage?: TokenUsage }
  | { kind: 'rejected'; rejection: string }
  | { kind: 'failed'; error: string };

function classifyMotionFailure(message: string): StudioPollOutcome {
  return isContentRejectionError(message)
    ? { kind: 'rejected', rejection: message }
    : { kind: 'failed', error: `Motion generation failed: ${message}` };
}

export class StudioGenerationWorkflow extends OpenStoryWorkflowEntrypoint<StudioGenerationWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const { assetId, input } = event.payload;

    await step.do('set-running', async () => {
      await scopedDb.generatedAssets.markRunning(assetId);
    });

    if (input.activity === 'image') {
      return this.runImage(event, input, step, scopedDb);
    }
    return this.runVideo(event, input, step, scopedDb);
  }

  private async runImage(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    input: Extract<StudioCreateInput, { activity: 'image' }>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const { assetId, teamId, userId } = event.payload;
    const { imageModel } = input;
    const imageSize = aspectRatioToImageSize(input.aspectRatio);

    const imageResult = await step.do('generate-image', async () => {
      logger.info(
        `[StudioGenerationWorkflow] Generating image ${assetId} with ${imageModel}`
      );
      return generateImageWithProvider(
        {
          model: imageModel,
          prompt: input.referenceImages.length
            ? tagStudioReferences(input.prompt)
            : input.prompt,
          imageSize,
          numImages: 1,
          ...(input.referenceImages.length > 0 && {
            referenceImageUrls: input.referenceImages,
          }),
        },
        {
          scopedDb: scopedDb.credentials,
          observability: {
            observationName: 'studio-image',
            tags: ['studio', 'image'],
            userId,
            metadata: { assetId, model: imageModel },
          },
        }
      );
    });

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }

    const imageCost = imageResult.metadata.cost ?? ZERO_MICROS;
    const falUsage =
      imageResult.via === 'fal'
        ? await recordFalUsageStep(step, scopedDb, imageResult.metadata)
        : {};

    if (imageCost > 0 && !imageResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: imageCost,
          usedOwnKey: imageResult.metadata.usedOwnKey,
          description: `Studio image (${imageModel})`,
          idempotencyKey: `${event.instanceId}:studio-image`,
          reservationId: event.payload.reservationId,
          metadata: {
            ...falUsage,
            model: imageModel,
            assetId,
          },
          workflowName: 'StudioGenerationWorkflow',
        });
      });
    }

    const upload = await step.do('upload-image', async () => {
      return uploadStudioImage({
        imageUrl: generatedImageUrl,
        teamId,
        assetId,
      });
    });

    const outputs: GeneratedAssetOutput[] = [
      { url: upload.url, contentType: upload.contentType },
    ];

    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId,
        userId,
        assetKind: 'generated_asset',
        assetId,
        storageKey: upload.path,
        provider: imageResult.via,
        model: imageResult.metadata.endpointId,
        providerRequestId: imageResult.metadata.requestId,
        workflowRunId: event.instanceId,
        prompt: input.prompt,
      });
    });

    await step.do('persist-result', async () => {
      await scopedDb.generatedAssets.markCompleted(assetId, {
        outputs,
        costMicros: imageCost,
      });
    });

    return { assetId, outputs };
  }

  private async runVideo(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    input: Extract<StudioCreateInput, { activity: 'video' }>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const { assetId, teamId, userId } = event.payload;
    const { videoModel } = input;

    let videoUrl = '';
    let billedUsage: TokenUsage | undefined;
    let lastRejection: string | null = null;
    let succeededJob: Awaited<ReturnType<typeof submitStudioVideoJob>> | null =
      null;

    for (let attempt = 0; attempt < MAX_MOTION_ATTEMPTS; attempt++) {
      const tag = attempt === 0 ? '' : `-retry-${attempt}`;
      const submitOutcome = await step.do(`submit-video${tag}`, async () => {
        try {
          const job = await submitStudioVideoJob({
            prompt: input.prompt,
            model: videoModel,
            duration: input.duration,
            aspectRatio: input.aspectRatio,
            generateAudio: input.generateAudio,
            mode: input.mode,
            referenceImages: input.referenceImages,
            referenceVideos: input.referenceVideos,
            referenceAudio: input.referenceAudio,
            startImageUrl: input.startImageUrl,
            endImageUrl: input.endImageUrl,
            scopedDb: scopedDb.credentials,
          });
          return { ok: true as const, job };
        } catch (error) {
          if (isContentRejectionError(error)) {
            return {
              ok: false as const,
              rejection: extractFalErrorMessage(error),
            };
          }
          if (
            error instanceof Error &&
            'status' in error &&
            error.status === 422
          ) {
            throw new NonRetryableError(
              `Video job submission rejected (422): ${extractFalErrorMessage(error)}`
            );
          }
          throw error;
        }
      });

      if (!submitOutcome.ok) {
        lastRejection = submitOutcome.rejection;
        logger.warn(
          `[StudioGenerationWorkflow] content-flag rejection on submit attempt ${attempt + 1}/${MAX_MOTION_ATTEMPTS} for ${assetId}: ${submitOutcome.rejection}`,
          { event: CONTENT_REJECTION_EVENT }
        );
        continue;
      }
      const { job } = submitOutcome;

      let rejected: string | null = null;
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        if (batch > 0) {
          await step.sleep(`video-batch-wait-${attempt}-${batch}`, 1);
        }

        const poll = await step.do(
          `video-poll-batch-${attempt}-${batch}`,
          async (): Promise<StudioPollOutcome> => {
            const deadline = Date.now() + POLL_BATCH_DURATION_MS;
            while (Date.now() < deadline) {
              let pollResult: Awaited<ReturnType<typeof pollStudioVideoJob>>;
              try {
                pollResult = await pollStudioVideoJob(
                  job,
                  scopedDb.credentials
                );
              } catch (error) {
                if (isContentRejectionError(error)) {
                  return {
                    kind: 'rejected',
                    rejection: extractFalErrorMessage(error),
                  };
                }
                if (
                  error instanceof Error &&
                  'status' in error &&
                  error.status === 422
                ) {
                  return {
                    kind: 'failed',
                    error: `Video job polling failed (422): ${extractFalErrorMessage(error)}`,
                  };
                }
                throw error;
              }

              if (pollResult.status === 'completed') {
                if (pollResult.url) {
                  let url = pollResult.url;
                  if (!videoUrlFitsWorkflowCheckpoint(url)) {
                    const googleKey =
                      job.via === 'google'
                        ? await scopedDb.credentials.resolveOptionalKey(
                            'google'
                          )
                        : undefined;
                    const stored = await uploadStudioVideo({
                      videoUrl: url,
                      teamId,
                      assetId,
                      googleApiKey: googleKey?.key,
                    });
                    url = stored.url;
                  }
                  return {
                    kind: 'completed',
                    url,
                    usage: pollResult.usage,
                  };
                }
                return classifyMotionFailure(
                  pollResult.error || 'No URL returned'
                );
              }
              if (pollResult.status === 'failed') {
                return classifyMotionFailure(
                  pollResult.error || 'Unknown error'
                );
              }
            }
            return { kind: 'pending' };
          }
        );

        if (poll.kind === 'completed') {
          videoUrl = poll.url;
          billedUsage = poll.usage;
          break;
        }
        if (poll.kind === 'rejected') {
          rejected = poll.rejection;
          break;
        }
        if (poll.kind === 'failed') {
          throw new NonRetryableError(poll.error);
        }
      }

      if (videoUrl) {
        succeededJob = job;
        break;
      }
      if (rejected) {
        lastRejection = rejected;
        continue;
      }
      throw new Error(
        `Video generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    if (!videoUrl || !succeededJob) {
      throw new NonRetryableError(
        clipContentRejectionMessage({
          rejections: [lastRejection ?? 'unknown rejection'],
          models: [IMAGE_TO_VIDEO_MODELS[videoModel].name],
          softened: false,
          // Text-to-video: no start still to regenerate — the only image
          // input is an optional reference (#1373).
          inputs: {
            still: input.referenceImages.length
              ? {
                  name: 'a reference image',
                  fix: 'Swap the reference image',
                }
              : undefined,
            prompt: 'the prompt',
          },
        }),
        'ContentRejectionExhausted'
      );
    }
    const job = succeededJob;

    const billing = await step.do('price-video-generation', async () =>
      studioVideoCostFromUsage(job, billedUsage)
    );
    const videoCost = billing.cost;

    if (billing.recordFalUsage) {
      await recordFalUsageStep(
        step,
        scopedDb,
        {
          endpointId: billing.endpointId,
          unitsBilled: billing.unitsBilled,
          numImages: 1,
        },
        'record-video-fal-usage'
      );
    }

    if (videoCost > 0 && !job.usedOwnKey) {
      await step.do('deduct-video-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: videoCost,
          usedOwnKey: job.usedOwnKey,
          description: `Studio video (${videoModel})`,
          idempotencyKey: `${event.instanceId}:studio-video`,
          reservationId: event.payload.reservationId,
          metadata: {
            model: videoModel,
            assetId,
            requestId: job.jobId,
          },
          workflowName: 'StudioGenerationWorkflow',
        });
      });
    }

    const videoUpload = await step.do('upload-video', async () => {
      const googleKey =
        job.via === 'google'
          ? await scopedDb.credentials.resolveOptionalKey('google')
          : undefined;
      return uploadStudioVideo({
        videoUrl,
        teamId,
        assetId,
        googleApiKey: googleKey?.key,
      });
    });

    const outputs: GeneratedAssetOutput[] = [
      { url: videoUpload.url, contentType: videoUpload.contentType },
    ];

    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId,
        userId,
        assetKind: 'generated_asset',
        assetId,
        storageKey: videoUpload.path,
        provider: job.via,
        model: billing.endpointId,
        providerRequestId: job.jobId,
        workflowRunId: event.instanceId,
        prompt: input.prompt,
      });
    });

    await step.do('persist-result', async () => {
      await scopedDb.generatedAssets.markCompleted(assetId, {
        outputs,
        costMicros: videoCost,
      });
    });

    return { assetId, outputs };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    await scopedDb.generatedAssets.markFailed(event.payload.assetId, error);
    logger.error(
      `[StudioGenerationWorkflow] Asset ${event.payload.assetId} failed: ${error}`
    );
  }
}
