/** One gateway job: send the caller's body on a platform key, store the media, charge the rate card. */

import { type Microdollars, ZERO_MICROS } from '@/billing/money';
import { isContentRejectionError } from '@/models/content-rejection';
import {
  extractPromptForProvenance,
  recordProvenance,
} from '@/platform/server/compliance/provenance';
import { z } from 'zod';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getLogger } from '@/platform/logger';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type { UserWorkflowContext } from '@/platform/server/workflow/types';
import {
  GATEWAY_VIA,
  type GatewayErrorCode,
  type GatewayJobInput,
  type GatewayJobKind,
  type GatewayJobOutput,
  type GatewayProvider,
} from '@/gateway/schema';
import { platformOnlyCredentials } from '@/gateway/server/platform-credentials';
import { priceGatewayJob } from '@/gateway/server/price';
import {
  GATEWAY_DRIVERS,
  type GatewayRunResult,
  type GatewayTarget,
} from '@/gateway/server/providers';
import { settleGatewayJob } from '@/gateway/server/settle';
import { storeGatewayOutput } from '@/gateway/server/storage';
import type { AppMargin } from '@/gateway/server/user-pays';
import {
  RateCardError,
  type RateCard,
} from '@modelschemas/rate-card/evaluator';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'gateway']);

const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const MAX_BATCHES = 60;

export interface GatewayGenerationWorkflowInput extends UserWorkflowContext {
  jobId: string;
  provider: GatewayProvider;
  kind: GatewayJobKind;
  target: GatewayTarget;
  /** The rate card as it read at submit, so the charge uses the price that was held. */
  card: RateCard;
  input: GatewayJobInput;
  /** The card's price for the request at submit; charged when the card cannot price the usage. */
  estimateMicros: Microdollars;
  /** The platform fee at submit; the hold is the charge on the estimate at this fee. */
  platformFeeBps: number;
  /** The OAuth client that submitted; null for an `osk_` key or a session. */
  oauthClientId: string | null;
  /** The registered app that client is, at submit. */
  appId: string | null;
  /** The margin applied at submit and its payee; the hold included it. */
  appMargin: AppMargin | null;
}

type Event = Readonly<WorkflowEvent<GatewayGenerationWorkflowInput>>;

/** A finished run with its media already in R2: small enough for a checkpoint. */
type Stored = {
  outputs: GatewayJobOutput[];
  /** JSON text: a recursive JSON type fails the step's Serializable check. */
  usageJson: string | null;
  requestId: string | null;
};

const usageSchema = z.record(z.string(), z.unknown());

type Started = { providerJobId: string } | { stored: Stored };

type PollOutcome =
  | { kind: 'pending' }
  | { kind: 'failed'; error: string }
  | { kind: 'stored'; stored: Stored };

/** The job's error code for a failure message. */
export function gatewayErrorCode(message: string): GatewayErrorCode {
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
    const { jobId, provider, kind, target, card, input } = event.payload;
    const { organizationId, userId } = event.payload;
    const credentials = platformOnlyCredentials(event.payload);
    const driver = GATEWAY_DRIVERS[provider];
    const via = GATEWAY_VIA[provider];

    // Media is stored in the step that received it (#1645): bytes never cross a checkpoint.
    const store = async (result: GatewayRunResult): Promise<Stored> => {
      if (result.media.length === 0) {
        throw new NonRetryableError('The model returned no output files');
      }
      const outputs: GatewayJobOutput[] = [];
      for (const [index, media] of result.media.entries()) {
        outputs.push(
          await storeGatewayOutput({
            media,
            kind,
            organizationId,
            jobId,
            index,
          })
        );
      }
      return {
        outputs,
        usageJson: result.usage ? JSON.stringify(result.usage) : null,
        requestId: result.requestId,
      };
    };

    await step.do('set-running', async () => {
      await scopedDb.gatewayJobs.markRunning(jobId);
    });

    const started = await step.do('start', async (): Promise<Started> => {
      const start = await driver.start(target, input, credentials);
      return 'jobId' in start
        ? { providerJobId: start.jobId }
        : { stored: await store(start.result) };
    });

    let stored = 'stored' in started ? started.stored : null;
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
          async (): Promise<PollOutcome> => {
            const deadline = Date.now() + POLL_BATCH_DURATION_MS;
            while (Date.now() < deadline) {
              const poll = await driver.poll(
                target,
                providerJobId,
                credentials
              );
              if (poll.status === 'failed') {
                return { kind: 'failed', error: poll.error };
              }
              if (poll.status === 'done') {
                return { kind: 'stored', stored: await store(poll.result) };
              }
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
    const { outputs, usageJson, requestId } = stored;
    const usage = usageJson ? usageSchema.parse(JSON.parse(usageJson)) : null;

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
    // Before the charge, so a charged job always has its outputs.
    await step.do('record-outputs', async () => {
      await scopedDb.gatewayJobs.recordOutputs(jobId, { outputs, via });
    });
    // The debit, its lines and `succeeded` are written together.
    await step.do('settle', async () => {
      let cost = ZERO_MICROS;
      try {
        cost = priceGatewayJob(card, input, usage);
      } catch (error) {
        if (!(error instanceof RateCardError)) throw error;
        logger.warn(
          `Rate card refused the usage of gateway job ${jobId}: ${error.message}`
        );
      }
      await settleGatewayJob({
        scopedDb,
        jobId,
        model: `${provider}/${target.modelId}`,
        reservationId: event.payload.reservationId,
        costMicros: cost,
        estimateMicros: event.payload.estimateMicros,
        platformFeeBps: event.payload.platformFeeBps,
        oauthClientId: event.payload.oauthClientId,
        appId: event.payload.appId,
        appMargin: event.payload.appMargin,
        usedOwnKey: false,
        idempotencyKey: `${event.instanceId}:gateway-settle`,
        result: { outputs, via },
        metadata: { provider, model: target.modelId, requestId },
      });
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
    // A charged job ends `succeeded` whatever failed after (`markFailed`).
    await scopedDb.gatewayJobs.markFailed(jobId, {
      code: gatewayErrorCode(error),
      message: error,
    });
    logger.warn(`Gateway job ${jobId} failed: ${error}`);
  }
}
