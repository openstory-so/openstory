/**
 * One gateway job (docs/architecture/model-gateway.md). Platform keys only:
 * the run never resolves an organization key. Image: generate and store in
 * one step (#1645), provenance, outputs, then settle and succeed in one step.
 * Video: submit, stamp the via, poll following the stamp, store, then the
 * same tail. The base class releases the hold on failure (`ownsReservation`).
 */

import { aspectRatioToImageSize } from '@/models/aspect-ratios';
import { isContentRejectionError } from '@/models/content-rejection';
import { extractFalErrorMessage } from '@/models/fal-error';
import { DEFAULT_RESOLUTION } from '@/models/resolutions';
import { assetLeaseOwner } from '@/models/server/byteplus-asset-pool';
import { ingestArkAssets } from '@/models/server/byteplus-asset-steps';
import type { MediaVia } from '@/models/via';
import { type Microdollars, ZERO_MICROS } from '@/billing/money';
import { recordFalUsageStep } from '@/billing/server/workflow-deduction';
import { resolveMotionVia } from '@/motion/server/motion-generation';
import {
  explainSeedanceFailure,
  seedanceSubmitRefusal,
} from '@/motion/seedance-edit';
import { videoUrlFitsWorkflowCheckpoint } from '@/motion/server/video-storage';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getLogger } from '@/platform/logger';
import { isEngineAbortError } from '@/platform/server/workflow/errors';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type { UserWorkflowContext } from '@/platform/server/workflow/types';
import { generateImageWithProvider } from '@/stills/server/image-generation';
import {
  arkStillsForStudio,
  pollStudioVideoJob,
  studioVideoCostFromUsage,
  submitStudioVideoJob,
} from '@/studio/server/studio-video-generation';
import { tagStudioReferences } from '@/studio/text-to-video';
import type { GatewayJobInput, GatewayJobOutput } from '@/gateway/schema';
import { gatewayVideoMode } from '@/gateway/server/models';
import { platformOnlyCredentials } from '@/gateway/server/platform-credentials';
import { settleGatewayJob } from '@/gateway/server/settle';
import type { AppMargin } from '@/gateway/server/user-pays';
import {
  uploadGatewayImage,
  uploadGatewayVideo,
} from '@/gateway/server/storage';
import type { TokenUsage } from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'gateway']);

const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_BATCHES = 60;

export interface GatewayGenerationWorkflowInput extends UserWorkflowContext {
  jobId: string;
  input: GatewayJobInput;
  /** Reference stills the likeness ledger cleared as showing no person, at submit. */
  noPersonImages: string[];
  /** The provider estimate at submit; charged when the provider reports no cost. */
  estimateMicros: Microdollars;
  /** The platform fee at submit; the hold is the charge on the estimate at this fee. */
  platformFeeBps: number;
  /** The OAuth client that submitted; null for an `osk_` key or a session. */
  oauthClientId: string | null;
  /** The registered app that client is, at submit; absent on runs from before apps. */
  appId?: string | null;
  /** The margin applied at submit and its payee; the hold included it. Absent before margins. */
  appMargin?: AppMargin | null;
}

type Event = Readonly<WorkflowEvent<GatewayGenerationWorkflowInput>>;

type PollOutcome =
  | { kind: 'pending' }
  | { kind: 'completed'; url: string; usage?: TokenUsage }
  | { kind: 'failed'; error: string };

/** The job's error code for a failure message. */
export function gatewayErrorCode(message: string): string {
  return isContentRejectionError(message)
    ? 'CONTENT_REJECTED'
    : 'GENERATION_FAILED';
}

export class GatewayGenerationWorkflow extends OpenStoryWorkflowEntrypoint<GatewayGenerationWorkflowInput> {
  protected override readonly failureLabel = 'Gateway job';

  protected override async runImpl(
    event: Event,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ jobId: string; outputs: GatewayJobOutput[] }> {
    const { jobId, input } = event.payload;
    await step.do('set-running', async () => {
      await scopedDb.gatewayJobs.markRunning(jobId);
    });
    return input.kind === 'image'
      ? this.runImage(event, input, step, scopedDb)
      : this.runVideo(event, input, step, scopedDb);
  }

  private async runImage(
    event: Event,
    input: Extract<GatewayJobInput, { kind: 'image' }>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ jobId: string; outputs: GatewayJobOutput[] }> {
    const { jobId, organizationId, userId } = event.payload;
    const credentials = platformOnlyCredentials(event.payload);
    const hasReferences = input.referenceImageUrls.length > 0;

    const generated = await step.do('generate-image', async () => {
      const result = await generateImageWithProvider(
        {
          model: input.model,
          prompt: hasReferences
            ? tagStudioReferences(input.prompt)
            : input.prompt,
          imageSize: aspectRatioToImageSize(input.aspectRatio),
          resolution: DEFAULT_RESOLUTION,
          numImages: 1,
          ...(hasReferences && {
            referenceImageUrls: input.referenceImageUrls,
          }),
        },
        {
          credentials,
          observability: {
            observationName: 'gateway-image',
            tags: ['gateway', 'image'],
            userId,
            metadata: { jobId, model: input.model },
          },
        }
      );
      const imageUrl = result.imageUrls[0];
      if (!imageUrl) throw new Error('Image generation returned no image');
      const upload = await uploadGatewayImage({
        imageUrl,
        organizationId,
        jobId,
      });
      return { upload, metadata: result.metadata, via: result.via };
    });

    const { metadata, via, upload } = generated;
    const cost = metadata.cost ?? ZERO_MICROS;
    const falUsage =
      via === 'fal' ? await recordFalUsageStep(step, scopedDb, metadata) : {};

    const outputs: GatewayJobOutput[] = [upload];
    await this.finish(event, step, scopedDb, {
      outputs,
      via,
      costMicros: cost,
      usedOwnKey: metadata.usedOwnKey,
      metadata: { ...falUsage, model: input.model, via },
      provenance: {
        provider: via,
        model: metadata.endpointId,
        providerRequestId: metadata.requestId,
      },
    });
    return { jobId, outputs };
  }

  private async runVideo(
    event: Event,
    input: Extract<GatewayJobInput, { kind: 'video' }>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ jobId: string; outputs: GatewayJobOutput[] }> {
    const { jobId, organizationId } = event.payload;
    const credentials = platformOnlyCredentials(event.payload);
    const mode = gatewayVideoMode(input);
    const owner = assetLeaseOwner('gateway', event.instanceId);

    const submitVia = await step.do('resolve-video-via', () =>
      resolveMotionVia(input.model, credentials)
    );
    const arkAssets =
      submitVia === 'byteplus'
        ? await ingestArkAssets(step, {
            prefix: 'gateway',
            stills: arkStillsForStudio(
              {
                mode,
                referenceImages: input.referenceImageUrls,
                startImageUrl: input.startImageUrl,
              },
              event.payload.noPersonImages
            ),
            ledger: scopedDb.bytePlusAssets,
            owner,
            credentials,
          })
        : {};

    const job = await step.do('submit-video', async () => {
      try {
        return await submitStudioVideoJob({
          arkAssets,
          prompt: input.prompt,
          model: input.model,
          duration: input.duration,
          aspectRatio: input.aspectRatio,
          resolution: DEFAULT_RESOLUTION,
          mode,
          referenceImages: input.referenceImageUrls,
          startImageUrl: input.startImageUrl,
          credentials,
        });
      } catch (error) {
        const message = extractFalErrorMessage(error);
        if (isContentRejectionError(error)) {
          throw new NonRetryableError(message, 'ContentRejection');
        }
        const refusal = seedanceSubmitRefusal(message, submitVia);
        if (refusal) throw new NonRetryableError(refusal);
        if (isUnprocessable(error)) {
          throw new NonRetryableError(`Video job rejected (422): ${message}`);
        }
        throw error;
      }
    });

    await step.do('stamp-provider-job', async () => {
      await scopedDb.gatewayJobs.stampProviderJob(jobId, {
        via: job.via,
        providerJobId: job.jobId,
      });
    });

    let videoUrl = '';
    let usage: TokenUsage | undefined;
    for (let batch = 0; batch < MAX_BATCHES && !videoUrl; batch++) {
      if (batch > 0) await step.sleep(`video-batch-wait-${batch}`, 1);
      const poll = await step.do(
        `video-poll-batch-${batch}`,
        async (): Promise<PollOutcome> => {
          const deadline = Date.now() + POLL_BATCH_DURATION_MS;
          while (Date.now() < deadline) {
            let result: Awaited<ReturnType<typeof pollStudioVideoJob>>;
            try {
              result = await pollStudioVideoJob(job, credentials);
            } catch (error) {
              // A refusal is the answer; anything else retries the step.
              if (isContentRejectionError(error) || isUnprocessable(error)) {
                return { kind: 'failed', error: extractFalErrorMessage(error) };
              }
              throw error;
            }
            if (result.status === 'completed') {
              if (!result.url) {
                return {
                  kind: 'failed',
                  error: result.error || 'No URL returned',
                };
              }
              let url = result.url;
              // Inline bytes cannot ride the 1 MiB checkpoint: store them here.
              if (!videoUrlFitsWorkflowCheckpoint(url)) {
                url = (
                  await uploadGatewayVideo({
                    videoUrl: url,
                    organizationId,
                    jobId,
                    googleApiKey: await googleKeyFor(job.via, credentials),
                  })
                ).url;
              }
              return { kind: 'completed', url, usage: result.usage };
            }
            if (result.status === 'failed') {
              return { kind: 'failed', error: result.error || 'Unknown error' };
            }
            await new Promise((resolve) =>
              setTimeout(resolve, POLL_INTERVAL_MS)
            );
          }
          return { kind: 'pending' };
        }
      );
      if (poll.kind === 'failed') {
        // The provider's own words, so a content refusal keeps its code.
        throw new NonRetryableError(
          explainSeedanceFailure(poll.error, job.via) ?? poll.error
        );
      }
      if (poll.kind === 'completed') {
        videoUrl = poll.url;
        usage = poll.usage;
      }
    }
    if (!videoUrl) {
      throw new NonRetryableError(
        `Video generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    // A release that never lands must not throw away a rendered clip; the lease TTL frees it.
    try {
      await step.do('release-byteplus-asset-leases', async () =>
        scopedDb.bytePlusAssets.releaseOwner(owner)
      );
    } catch (releaseError) {
      if (isEngineAbortError(releaseError)) throw releaseError;
      logger.error(
        `Failed to release BytePlus leases for gateway job ${jobId}`,
        {
          err: releaseError,
        }
      );
    }

    const billing = await step.do('price-video', async () =>
      studioVideoCostFromUsage(job, usage)
    );
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

    const upload = await step.do('upload-video', async () =>
      uploadGatewayVideo({
        videoUrl,
        organizationId,
        jobId,
        googleApiKey: await googleKeyFor(job.via, credentials),
      })
    );

    // Charged only for a clip that was stored.
    const outputs: GatewayJobOutput[] = [upload];
    await this.finish(event, step, scopedDb, {
      outputs,
      via: job.via,
      costMicros: billing.cost,
      usedOwnKey: job.usedOwnKey,
      metadata: { model: input.model, via: job.via, requestId: job.jobId },
      provenance: {
        provider: job.via,
        model: billing.endpointId,
        providerRequestId: job.jobId,
      },
    });
    return { jobId, outputs };
  }

  /**
   * Provenance, then the outputs, then the charge and the success in one
   * step: nothing after the charge can fail the job.
   */
  private async finish(
    event: Event,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb,
    result: {
      outputs: GatewayJobOutput[];
      via: MediaVia;
      costMicros: Microdollars;
      usedOwnKey: boolean;
      metadata: Record<string, unknown>;
      provenance: {
        provider: MediaVia;
        model: string;
        providerRequestId?: string;
      };
    }
  ): Promise<void> {
    const { jobId, organizationId, userId, input } = event.payload;
    const [stored] = result.outputs;
    if (!stored) throw new Error('A gateway job finished with no output');
    if (result.usedOwnKey) {
      throw new NonRetryableError(
        `Gateway job ${jobId} ran on an organization key`
      );
    }
    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        organizationId,
        userId,
        assetKind: 'gateway_job',
        assetId: jobId,
        storageKey: stored.path,
        ...result.provenance,
        workflowRunId: event.instanceId,
        prompt: input.prompt,
      });
    });
    await step.do('record-outputs', async () => {
      await scopedDb.gatewayJobs.recordOutputs(jobId, {
        outputs: result.outputs,
        via: result.via,
      });
    });
    await step.do('settle', async () => {
      await settleGatewayJob({
        scopedDb,
        jobId,
        model: input.model,
        reservationId: event.payload.reservationId,
        costMicros: result.costMicros,
        estimateMicros: event.payload.estimateMicros,
        platformFeeBps: event.payload.platformFeeBps,
        oauthClientId: event.payload.oauthClientId,
        appId: event.payload.appId ?? null,
        appMargin: event.payload.appMargin ?? null,
        usedOwnKey: result.usedOwnKey,
        idempotencyKey: `${event.instanceId}:gateway-settle`,
        result: { outputs: result.outputs, via: result.via },
        metadata: result.metadata,
      });
    });
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Event;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const { jobId, input } = event.payload;
    await scopedDb.gatewayJobs.markFailed(jobId, {
      code: gatewayErrorCode(error),
      message: error,
    });
    if (input.kind === 'video') {
      await scopedDb.bytePlusAssets.releaseOwner(
        assetLeaseOwner('gateway', event.instanceId)
      );
    }
    logger.warn(`Gateway job ${jobId} failed: ${error}`);
  }
}

function isUnprocessable(error: unknown): boolean {
  return error instanceof Error && 'status' in error && error.status === 422;
}

async function googleKeyFor(
  via: MediaVia,
  credentials: ReturnType<typeof platformOnlyCredentials>
): Promise<string | undefined> {
  if (via !== 'google') return undefined;
  return (await credentials.resolveOptionalKey('google'))?.key;
}
