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
  finishGatewayRun,
  type GatewayRun,
  type GatewayStore,
  type GatewayStored,
  pollGatewayRun,
  releaseGatewayRun,
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
    reservationId: z.string(),
  }),
  providerJobId: z.string(),
});

export function inProcessGateway(params: {
  scopedDb: WorkflowScopedDb;
  /** The model as it read at the trigger: its schema and card are not fetched mid-run. */
  model: GatewayModel;
  /** The caller's run, so the stale-job sweep can end a job whose run died. */
  runId: string;
  /** Replay-stable, e.g. `${instanceId}:${stepName}`: a retried step reuses the job and its hold. One transport, one job. */
  idempotencyKey: string;
  /** Called inside the step that received the media (#1645). */
  store: GatewayStore;
  /** The caller ran `requireUploadRights` on every URL in the body before the run. */
  uploadRightsChecked: typeof UPLOAD_RIGHTS_CHECKED;
}): GatewayTransport {
  const { scopedDb, store } = params;
  const credentials = platformOnlyCredentials(scopedDb);

  const finish = async (run: GatewayRun, stored: GatewayStored) => {
    await finishGatewayRun(
      scopedDb,
      run,
      stored,
      `gateway:${run.jobId}:settle`
    );
    return { kind: 'done' as const, outputs: stored.outputs };
  };

  let submitted = false;
  return {
    submit: async (body: GatewayJobInput) => {
      // One key is one job: a second submit would answer with the first job.
      if (submitted) {
        throw new NonRetryableError(
          'An in-process transport runs one job: build one per call'
        );
      }
      submitted = true;
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
        await releaseGatewayRun(scopedDb, run, error);
        throw new NonRetryableError(error);
      }
      await scopedDb.gatewayJobs.attachRun(run.jobId, {
        reservationId: run.reservationId,
        workflowRunId: params.runId,
      });
      if (!(await scopedDb.gatewayJobs.markRunning(run.jobId))) {
        throw new Error('Another attempt is starting this job');
      }
      const started = await startGatewayRun(run, credentials, store).catch(
        async (error: unknown) => {
          if (error instanceof NonRetryableError) {
            await releaseGatewayRun(scopedDb, run, error.message);
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
      const { run, providerJobId } = handleSchema.parse(JSON.parse(handle));
      // A retried poll whose job already ended answers from the row: no second store, no second charge.
      const job = await scopedDb.claims.gatewayJobs.getById(run.jobId);
      if (job?.status === 'succeeded') {
        return { kind: 'done' as const, outputs: job.outputs ?? [] };
      }
      if (job?.status === 'failed') {
        return {
          kind: 'failed' as const,
          error: job.error?.message ?? 'Generation failed',
        };
      }
      const polled = await pollGatewayRun(
        run,
        providerJobId,
        credentials,
        store
      );
      if (polled.kind === 'pending') return polled;
      if (polled.kind === 'failed') {
        await releaseGatewayRun(scopedDb, run, polled.error);
        return polled;
      }
      return finish(run, polled.stored);
    },
  };
}
