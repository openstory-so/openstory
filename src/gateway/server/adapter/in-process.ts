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
  type GatewayJobOutput,
} from '@/gateway/schema';
import type { GatewayPoller, GatewayTransport } from '@/gateway/server/adapter';
import type { GatewayJob } from '@/platform/server/db/schema';
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
    // A handle from before #2435 always owned its hold.
    ownsReservation: z.boolean().default(true),
  }),
  providerJobId: z.string(),
});

/** The outputs of a job that succeeded; a success with none is an error, never zero media. */
function storedOutputs(job: GatewayJob): GatewayJobOutput[] {
  if (!job.outputs?.length) {
    throw new NonRetryableError(
      `Gateway job ${job.id} succeeded with no outputs`
    );
  }
  return job.outputs;
}

async function finish(
  scopedDb: WorkflowScopedDb,
  run: GatewayRun,
  stored: GatewayStored
) {
  await finishGatewayRun(scopedDb, run, stored, `gateway:${run.jobId}:settle`);
  return { kind: 'done' as const, outputs: stored.outputs };
}

/** Polls a handle `submit` gave out. Needs no model, key or rights: a poll step builds only this. */
export function inProcessPoller(params: {
  scopedDb: WorkflowScopedDb;
  /** Called inside the step that received the media (#1645). */
  store: GatewayStore;
}): GatewayPoller {
  const { scopedDb, store } = params;
  const credentials = platformOnlyCredentials(scopedDb);
  return {
    poll: async (handle: string) => {
      const { run, providerJobId } = handleSchema.parse(JSON.parse(handle));
      // A retried poll whose job already ended answers from the row: no second store, no second charge.
      const job = await scopedDb.claims.gatewayJobs.getById(run.jobId);
      if (job?.status === 'succeeded') {
        return { kind: 'done' as const, outputs: storedOutputs(job) };
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
      return finish(scopedDb, run, polled.stored);
    },
  };
}

/** The gateway job and provider a queued handle names; null for a job that answered at submit (`done:`), which carries none. */
export function gatewayRunOf(
  handle: string
): Pick<GatewayRun, 'jobId' | 'provider'> | null {
  if (handle.startsWith('done:')) return null;
  const { run } = handleSchema.parse(JSON.parse(handle));
  return { jobId: run.jobId, provider: run.provider };
}

/** Ends a queued job its caller gave up on: failed now, its own hold released, not left to the sweep. */
export async function releaseInProcessJob(
  scopedDb: WorkflowScopedDb,
  handle: string,
  error: string
): Promise<void> {
  const { run } = handleSchema.parse(JSON.parse(handle));
  await releaseGatewayRun(scopedDb, run, error);
}

/** Holds, starts and polls in the caller's steps. Stateless: the key comes with each submit. */
export function inProcessGateway(params: {
  scopedDb: WorkflowScopedDb;
  /** The model as it read at the trigger: its schema and card are not fetched mid-run. */
  model: GatewayModel;
  /** The caller's run, so the stale-job sweep can end a job whose run died. */
  runId: string;
  /** Called inside the step that received the media (#1645). */
  store: GatewayStore;
  /** The caller ran `requireUploadRights` on every URL in the body before the run. */
  uploadRightsChecked: typeof UPLOAD_RIGHTS_CHECKED;
  /** The caller's run reservation: jobs charge it instead of holding their own; null holds per job. */
  reservation: { readonly id: string } | null;
}): GatewayTransport {
  const { scopedDb, store } = params;
  const credentials = platformOnlyCredentials(scopedDb);
  return {
    ...inProcessPoller({ scopedDb, store }),
    submit: async (body: GatewayJobInput, idempotencyKey: string) => {
      let run: GatewayRun;
      let job: GatewayJob;
      try {
        ({ run, job } = await holdGatewayJob(params.model, body, {
          scopedDb,
          rights: params.uploadRightsChecked,
          idempotencyKey,
          oauthClientId: null,
          runReservationId: params.reservation?.id ?? null,
        }));
      } catch (error) {
        // A refusal (body, price, credits, key reused for another body) is the answer, not a blip to retry.
        if (error instanceof OpenStoryError && error.statusCode < 500) {
          throw new NonRetryableError(error.message);
        }
        throw error;
      }
      // A replayed job is never started twice: only a queued one starts here.
      if (job.status === 'succeeded') {
        return { kind: 'done' as const, outputs: storedOutputs(job) };
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
      // A borrowed hold stays off the row, so the stale-job sweep never zeroes the caller's reservation.
      await scopedDb.gatewayJobs.attachRun(run.jobId, {
        reservationId: run.ownsReservation ? run.reservationId : null,
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
      if ('stored' in started) return finish(scopedDb, run, started.stored);
      await scopedDb.gatewayJobs.stampProviderJob(run.jobId, {
        via: GATEWAY_VIA[run.provider],
        providerJobId: started.providerJobId,
      });
      return {
        kind: 'queued' as const,
        handle: JSON.stringify({ run, providerJobId: started.providerJobId }),
      };
    },
  };
}
