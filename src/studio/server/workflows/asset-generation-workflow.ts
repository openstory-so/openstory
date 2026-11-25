/**
 * One Models page run (#458, #2433): the `openstory` adapter over the
 * in-process gateway on platform keys (held and charged by the gateway), or
 * the fal driver on the organization's own fal key, unbilled. Outputs land in
 * `teams/<org>/assets/<assetId>/` inside the step that received them.
 */

import { isContentRejectionError } from '@/models/content-rejection';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { GeneratedAssetOutput } from '@/platform/server/db/schema';
import { getLogger } from '@/platform/logger';
import {
  extractPromptForProvenance,
  recordProvenance,
} from '@/platform/server/compliance/provenance';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type { AssetGenerationWorkflowInput } from '@/platform/server/workflow/types';
import type { GatewayJobOutput } from '@/gateway/schema';
import {
  type GatewayTransport,
  openstoryAudio,
  openstoryImage,
  openstoryVideo,
} from '@/gateway/server/adapter';
import { inProcessGateway } from '@/gateway/server/adapter/in-process';
import { type GatewayStore, storeGatewayResult } from '@/gateway/server/phases';
import type { GatewayCredentials } from '@/gateway/server/platform-credentials';
import { GATEWAY_DRIVERS } from '@/gateway/server/providers';
import { storeGatewayOutput } from '@/gateway/server/storage';
import { UPLOAD_RIGHTS_CHECKED } from '@/gateway/server/submit-job';
import {
  generateAudio,
  generateImage,
  generateVideo,
  getVideoJobStatus,
} from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'asset']);

const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_BATCHES = 60;

type Event = Readonly<WorkflowEvent<AssetGenerationWorkflowInput>>;

/** Today's direct path: the fal queue on the organization's own key, never the platform's. */
function directFal(
  scopedDb: WorkflowScopedDb,
  endpointId: string,
  store: GatewayStore
): GatewayTransport {
  const target = { modelId: endpointId, endpointId };
  const credentials: GatewayCredentials = {
    organizationId: scopedDb.organizationId,
    userId: scopedDb.userId,
    resolveOptionalKey: scopedDb.credentials.resolveOptionalKey,
    resolveKey: async (provider) => {
      const key = await scopedDb.credentials.resolveKey(provider);
      // The run was routed here for the organization's key: never spend the platform's unbilled.
      if (key.source !== 'organization') {
        throw new NonRetryableError('Your own fal key is no longer usable');
      }
      return key;
    },
  };
  const fal = GATEWAY_DRIVERS.fal;
  return {
    submit: async (body) => {
      const start = await fal.start(target, body, credentials);
      if ('jobId' in start) return { kind: 'queued', handle: start.jobId };
      const stored = await storeGatewayResult(start.result, store);
      return { kind: 'done', outputs: stored.outputs };
    },
    poll: async (handle) => {
      const polled = await fal.poll(target, handle, credentials);
      if (polled.status !== 'done') {
        return polled.status === 'failed'
          ? { kind: 'failed', error: polled.error }
          : { kind: 'pending' };
      }
      const stored = await storeGatewayResult(polled.result, store);
      return { kind: 'done', outputs: stored.outputs };
    },
  };
}

export class AssetGenerationWorkflow extends OpenStoryWorkflowEntrypoint<AssetGenerationWorkflowInput> {
  protected override readonly failureLabel = 'Studio generation';

  protected override async runImpl(
    event: Event,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const { assetId, activity, input, route, organizationId, userId } =
      event.payload;
    const model = route.via === 'openstory' ? route.model.id : route.endpointId;

    /** A transport for one step; its store collects what that step wrote, so the step returns it. */
    const transport = (stored: GatewayJobOutput[]): GatewayTransport => {
      const store: GatewayStore = async (media, index) => {
        const output = await storeGatewayOutput({
          media,
          kind: activity,
          organizationId,
          folder: `assets/${assetId}`,
          index,
        });
        stored.push(output);
        return output;
      };
      return route.via === 'openstory'
        ? inProcessGateway({
            scopedDb,
            model: route.model,
            runId: event.instanceId,
            // The click held under this key: the run finds that job and its hold.
            idempotencyKey: `asset:${assetId}`,
            store,
            uploadRightsChecked: UPLOAD_RIGHTS_CHECKED,
          })
        : directFal(scopedDb, route.endpointId, store);
    };

    await step.do('set-running', async () => {
      await scopedDb.generatedAssets.markRunning(assetId);
    });

    let outputs: GatewayJobOutput[];
    if (activity === 'video') {
      const submitted = await step.do('submit', async () => {
        const stored: GatewayJobOutput[] = [];
        const job = await generateVideo({
          adapter: openstoryVideo(model, transport(stored)),
          prompt: '',
          modelOptions: input,
          threadId: event.instanceId,
        });
        return { jobId: job.jobId, stored };
      });
      outputs = submitted.stored;
      for (
        let batch = 0;
        batch < MAX_BATCHES && outputs.length === 0;
        batch++
      ) {
        if (batch > 0) await step.sleep(`poll-wait-${batch}`, 1);
        outputs = await step.do(`poll-batch-${batch}`, async () => {
          const deadline = Date.now() + POLL_BATCH_DURATION_MS;
          while (Date.now() < deadline) {
            const stored: GatewayJobOutput[] = [];
            const status = await getVideoJobStatus({
              adapter: openstoryVideo(model, transport(stored)),
              jobId: submitted.jobId,
            });
            if (status.status === 'failed') {
              throw new NonRetryableError(status.error ?? 'Generation failed');
            }
            if (status.status === 'completed') return stored;
            await new Promise((resolve) =>
              setTimeout(resolve, POLL_INTERVAL_MS)
            );
          }
          return [];
        });
      }
      if (outputs.length === 0) {
        throw new NonRetryableError(
          `Generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
        );
      }
    } else {
      outputs = await step.do('generate', async () => {
        const stored: GatewayJobOutput[] = [];
        const options = {
          prompt: '',
          modelOptions: input,
          threadId: event.instanceId,
        };
        if (activity === 'image') {
          await generateImage({
            adapter: openstoryImage(model, transport(stored)),
            ...options,
          });
        } else {
          await generateAudio({
            adapter: openstoryAudio(model, transport(stored)),
            ...options,
          });
        }
        return stored;
      });
    }

    const assetOutputs = outputs.map(({ url, contentType }) => ({
      url,
      contentType,
    }));
    await step.do('persist-result', async () => {
      await scopedDb.generatedAssets.markCompleted(assetId, {
        outputs: assetOutputs,
        provider: route.via,
      });
    });

    // One provenance row per output (#1180): each is separately shareable.
    await step.do('record-provenance', async () => {
      for (const [index, output] of outputs.entries()) {
        await recordProvenance(scopedDb.provenance, {
          organizationId,
          userId,
          assetKind: 'generated_asset',
          assetId: outputs.length > 1 ? `${assetId}#${index}` : assetId,
          storageKey: output.path,
          provider: route.via,
          model,
          providerRequestId: null,
          workflowRunId: event.instanceId,
          prompt: extractPromptForProvenance(input),
        });
      }
    });

    return { assetId, outputs: assetOutputs };
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
    const { assetId } = event.payload;
    await scopedDb.generatedAssets.markFailed(assetId, error);
    if (isContentRejectionError(error)) {
      logger.warn(`Asset ${assetId} failed: ${error}`);
    } else {
      logger.error(`Asset ${assetId} failed: ${error}`);
    }
  }
}
