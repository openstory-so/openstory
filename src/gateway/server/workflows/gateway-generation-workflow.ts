/** One gateway job: send the caller's body on a platform key, store the media, charge the rate card. */

import {
  extractPromptForProvenance,
  recordProvenance,
} from '@/platform/server/compliance/provenance';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getLogger } from '@/platform/logger';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type { UserWorkflowContext } from '@/platform/server/workflow/types';
import { GATEWAY_VIA, type GatewayJobOutput } from '@/gateway/schema';
import {
  finishGatewayRun,
  type GatewayPolled,
  type GatewayRun,
  type GatewayStarted,
  type GatewayStore,
  type GatewayStored,
  pollGatewayRun,
  releaseGatewayRun,
  startGatewayRun,
} from '@/gateway/server/phases';
import { platformOnlyCredentials } from '@/gateway/server/platform-credentials';
import { storeGatewayOutput } from '@/gateway/server/storage';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'gateway']);

const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_BATCHES = 60;

export interface GatewayGenerationWorkflowInput
  extends Omit<UserWorkflowContext, 'reservationId'>, GatewayRun {}

type Event = Readonly<WorkflowEvent<GatewayGenerationWorkflowInput>>;

export class GatewayGenerationWorkflow extends OpenStoryWorkflowEntrypoint<GatewayGenerationWorkflowInput> {
  protected override readonly failureLabel = 'Gateway job';

  protected override async runImpl(
    event: Event,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<{ jobId: string; outputs: GatewayJobOutput[] }> {
    const run: GatewayRun = event.payload;
    const { jobId, provider, kind, target, input } = run;
    const { organizationId, userId } = event.payload;
    const credentials = platformOnlyCredentials(event.payload);
    const via = GATEWAY_VIA[provider];
    const store: GatewayStore = (media, index) =>
      storeGatewayOutput({
        media,
        kind,
        organizationId,
        folder: `gateway/${jobId}`,
        index,
      });

    await step.do('set-running', async () => {
      await scopedDb.gatewayJobs.markRunning(jobId);
    });

    const started = await step.do('start', (): Promise<GatewayStarted> =>
      startGatewayRun(run, credentials, store)
    );

    let stored: GatewayStored | null =
      'stored' in started ? started.stored : null;
    if ('providerJobId' in started) {
      const { providerJobId } = started;
      await step.do('stamp-provider-job', async () => {
        await scopedDb.gatewayJobs.stampProviderJob(jobId, {
          via,
          providerJobId,
        });
      });
      for (let batch = 0; batch < MAX_BATCHES && !stored; batch++) {
        if (batch > 0) await step.sleep(`poll-wait-${batch}`, 1);
        const outcome = await step.do(
          `poll-batch-${batch}`,
          async (): Promise<GatewayPolled> => {
            const deadline = Date.now() + POLL_BATCH_DURATION_MS;
            while (Date.now() < deadline) {
              const polled = await pollGatewayRun(
                run,
                providerJobId,
                credentials,
                store
              );
              if (polled.kind !== 'pending') return polled;
              await new Promise((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS)
              );
            }
            return { kind: 'pending' };
          }
        );
        if (outcome.kind === 'failed') {
          throw new NonRetryableError(outcome.error);
        }
        if (outcome.kind === 'stored') stored = outcome.stored;
      }
    }
    if (!stored) {
      throw new NonRetryableError(
        `Generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }
    const { outputs, requestId } = stored;

    await step.do('record-provenance', async () => {
      for (const output of outputs) {
        await recordProvenance(scopedDb.provenance, {
          organizationId,
          userId,
          assetKind: 'gateway_job',
          assetId: jobId,
          storageKey: output.path,
          provider: via,
          model: target.modelId,
          providerRequestId: requestId,
          workflowRunId: event.instanceId,
          prompt: extractPromptForProvenance(input),
        });
      }
    });
    // Outputs, then the debit, its lines and `succeeded`.
    await step.do('settle', async () => {
      await finishGatewayRun(
        scopedDb,
        run,
        stored,
        `${event.instanceId}:gateway-settle`
      );
    });
    return { jobId, outputs };
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
    const { jobId } = event.payload;
    await releaseGatewayRun(scopedDb, event.payload, error);
    logger.warn(`Gateway job ${jobId} failed: ${error}`);
  }
}
