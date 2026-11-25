/**
 * The in-process transport: the gateway's phases run inside the caller's own
 * step, on platform keys, held and charged here (docs/architecture/model-gateway.md
 * § The openstory adapter).
 */

import { micros } from '@/billing/money';
import { OpenStoryError } from '@/platform/errors';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  GATEWAY_JOB_KINDS,
  GATEWAY_PROVIDERS,
  GATEWAY_VIA,
  type GatewayJobInput,
} from '@/gateway/schema';
import type { GatewayTransport } from '@/gateway/server/adapter';
import type { GatewayModel } from '@/gateway/server/catalog';
import {
  gatewayErrorCode,
  type GatewayRun,
  type GatewayStore,
  type GatewayStored,
  pollGatewayRun,
  settleGatewayRun,
  startGatewayRun,
} from '@/gateway/server/phases';
import { platformOnlyCredentials } from '@/gateway/server/platform-credentials';
import {
  holdGatewayJob,
  type UPLOAD_RIGHTS_CHECKED,
} from '@/gateway/server/submit-job';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';

/** A queued job's handle: everything a later poll step needs, so it reads no row. */
const handleSchema = z.object({
  run: z.object({
    jobId: z.string(),
    provider: z.enum(GATEWAY_PROVIDERS),
    kind: z.enum(GATEWAY_JOB_KINDS),
    target: z.object({ modelId: z.string(), endpointId: z.string() }),
    card: rateCardSchema,
    input: z.record(z.string(), z.json()),
    estimateMicros: z.number().transform(micros),
    platformFeeBps: z.number(),
    oauthClientId: z.string().nullable(),
    reservationId: z.string().optional(),
  }),
  providerJobId: z.string(),
});

export function inProcessGateway(params: {
  scopedDb: WorkflowScopedDb;
  /** The model as it read at the trigger: its schema and card are not fetched mid-run. */
  model: GatewayModel;
  /** The caller's run, so the stale-job sweep can end a job whose run died. */
  runId: string;
  /** Replay-stable per call, e.g. `${instanceId}:${stepName}`: a retried step reuses the job and its hold. */
  idempotencyKey: string;
  /** Called inside the step that received the media (#1645). */
  store: GatewayStore;
  /** The caller ran `requireUploadRights` on every URL in the body before the run. */
  uploadRightsChecked: typeof UPLOAD_RIGHTS_CHECKED;
}): GatewayTransport {
  const { scopedDb, store } = params;
  const credentials = platformOnlyCredentials(scopedDb);

  const finish = async (run: GatewayRun, stored: GatewayStored) => {
    const via = GATEWAY_VIA[run.provider];
    // Before the charge, so a charged job always has its outputs.
    await scopedDb.gatewayJobs.recordOutputs(run.jobId, {
      outputs: stored.outputs,
      via,
    });
    await settleGatewayRun(
      scopedDb,
      run,
      stored,
      `gateway:${run.jobId}:settle`
    );
    return { kind: 'done' as const, outputs: stored.outputs };
  };

  /** Ends the job failed and lets its hold go. */
  const release = async (run: GatewayRun, error: string) => {
    await scopedDb.gatewayJobs.markFailed(run.jobId, {
      code: gatewayErrorCode(error),
      message: error,
    });
    if (run.reservationId) {
      await scopedDb.billing.zeroReservation(run.reservationId);
    }
  };

  return {
    submit: async (body: GatewayJobInput) => {
      let run: GatewayRun;
      let job: Awaited<ReturnType<typeof holdGatewayJob>>['job'];
      try {
        ({ run, job } = await holdGatewayJob(params.model, body, {
          scopedDb,
          rights: params.uploadRightsChecked,
          idempotencyKey: params.idempotencyKey,
          oauthClientId: null,
        }));
      } catch (error) {
        // A refusal (body, price, credits, key) is the answer to this call, not a blip to retry.
        if (error instanceof OpenStoryError && error.statusCode < 500) {
          throw new NonRetryableError(error.message);
        }
        throw error;
      }
      // A replayed job is never started twice: only a queued one starts here.
      if (job.status === 'succeeded') {
        return { kind: 'done' as const, outputs: job.outputs ?? [] };
      }
      if (job.status === 'failed') {
        throw new NonRetryableError(job.error?.message ?? 'Generation failed');
      }
      if (job.status === 'running') {
        if (job.providerJobId) {
          return {
            kind: 'queued' as const,
            handle: JSON.stringify({ run, providerJobId: job.providerJobId }),
          };
        }
        // Started but never stamped: the provider may have it, so it is failed rather than sent again.
        const error = 'The previous attempt may have started this job';
        await release(run, error);
        throw new NonRetryableError(error);
      }
      await scopedDb.gatewayJobs.attachRun(run.jobId, {
        reservationId: run.reservationId ?? null,
        workflowRunId: params.runId,
      });
      await scopedDb.gatewayJobs.markRunning(run.jobId);
      const started = await startGatewayRun(run, credentials, store).catch(
        async (error: unknown) => {
          if (error instanceof NonRetryableError) {
            await release(run, error.message);
          }
          throw error;
        }
      );
      if ('stored' in started) return finish(run, started.stored);
      await scopedDb.gatewayJobs.stampProviderJob(run.jobId, {
        via: GATEWAY_VIA[run.provider],
        providerJobId: started.providerJobId,
      });
      return {
        kind: 'queued' as const,
        handle: JSON.stringify({ run, providerJobId: started.providerJobId }),
      };
    },

    poll: async (handle: string) => {
      const parsed = handleSchema.parse(JSON.parse(handle));
      const { providerJobId } = parsed;
      const run: GatewayRun = {
        ...parsed.run,
        reservationId: parsed.run.reservationId,
      };
      const polled = await pollGatewayRun(
        run,
        providerJobId,
        credentials,
        store
      );
      if (polled.kind === 'pending') return polled;
      if (polled.kind === 'failed') {
        await release(run, polled.error);
        return polled;
      }
      return finish(run, polled.stored);
    },
  };
}
