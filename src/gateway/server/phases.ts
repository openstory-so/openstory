/**
 * The run of a held gateway job as phases a caller runs in its own steps:
 * start, poll, finish, release (docs/architecture/model-gateway.md § Phases).
 * The hold is `holdGatewayJob` in submit-job.ts.
 */

import { type Microdollars, ZERO_MICROS } from '@/billing/money';
import { isContentRejectionError } from '@/models/content-rejection';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getLogger } from '@/platform/logger';
import {
  GATEWAY_VIA,
  type GatewayErrorCode,
  type GatewayJobInput,
  type GatewayJobKind,
  type GatewayJobOutput,
  type GatewayProvider,
} from '@/gateway/schema';
import type { GatewayCredentials } from '@/gateway/server/platform-credentials';
import { heldOutputs, priceGatewayJob } from '@/gateway/server/price';
import {
  GATEWAY_DRIVERS,
  type GatewayMedia,
  type GatewayRunResult,
  type GatewayTarget,
} from '@/gateway/server/providers';
import { settleGatewayJob } from '@/gateway/server/settle';
import {
  RateCardError,
  type RateCard,
} from '@modelschemas/rate-card/evaluator';
import { cardParams } from '@modelschemas/rate-card/evaluator';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';

const logger = getLogger(['openstory', 'gateway', 'phases']);

/** A held job: everything its run needs, snapshotted at the hold. */
export type GatewayRun = {
  jobId: string;
  provider: GatewayProvider;
  kind: GatewayJobKind;
  target: GatewayTarget;
  /** The rate card as it read at the hold, so the charge uses the price that was held. */
  card: RateCard;
  input: GatewayJobInput;
  /** The card's price for the request at the hold; charged when the card cannot price the usage. */
  estimateMicros: Microdollars;
  /** The platform fee at the hold; the hold is the charge on the estimate at this fee. */
  platformFeeBps: number;
  /** The OAuth client that submitted; null for an `osk_` key, a session or the product. */
  oauthClientId: string | null;
  /** The hold; every gateway job is held before it runs. */
  reservationId: string;
  /** False when the hold is the caller's run reservation: the job charges it but never zeroes it. */
  ownsReservation: boolean;
};

/** Streams one output into the caller's storage, inside the step that received it (#1645). */
export type GatewayStore = (
  media: GatewayMedia,
  index: number
) => Promise<GatewayJobOutput>;

/** A finished run with its media already stored: small enough for a checkpoint. */
export type GatewayStored = {
  outputs: GatewayJobOutput[];
  /** JSON text: a recursive JSON type fails the step's Serializable check. */
  usageJson: string | null;
  requestId: string | null;
};

export type GatewayStarted =
  | { providerJobId: string }
  | { stored: GatewayStored };

export type GatewayPolled =
  | { kind: 'pending' }
  | { kind: 'failed'; error: string }
  | { kind: 'stored'; stored: GatewayStored };

/** The job's error code for a failure message. */
export function gatewayErrorCode(message: string): GatewayErrorCode {
  return isContentRejectionError(message)
    ? 'CONTENT_REJECTED'
    : 'GENERATION_FAILED';
}

const usageSchema = z.record(z.string(), z.unknown());

export async function storeGatewayResult(
  result: GatewayRunResult,
  store: GatewayStore
): Promise<GatewayStored> {
  if (result.media.length === 0) {
    throw new NonRetryableError('The model returned no output files');
  }
  const outputs: GatewayJobOutput[] = [];
  for (const [index, media] of result.media.entries()) {
    outputs.push(await store(media, index));
  }
  return {
    outputs,
    usageJson: result.usage ? JSON.stringify(result.usage) : null,
    requestId: result.requestId,
  };
}

/** Only the outputs the hold covers are stored and charged; extras are dropped. */
/** A usage lever that grows with what the model returns: output tokens, megapixels, seconds, generated images; never an input. */
function isOutputLever(name: string): boolean {
  return (
    !/input|cached|reference|prompt/i.test(name) &&
    /output|generated|completion|megapixel|^tokens$|duration|seconds|minutes/i.test(
      name
    )
  );
}

function heldResult(
  run: GatewayRun,
  result: GatewayRunResult
): GatewayRunResult {
  // A card that charges each output from usage pays for every output it returns.
  if (cardParams(run.card).usage.some(isOutputLever)) return result;
  const held = heldOutputs(run.input);
  if (result.media.length <= held) return result;
  logger.warn('gateway model returned more outputs than were held', {
    jobId: run.jobId,
    returned: result.media.length,
    held,
  });
  return { ...result, media: result.media.slice(0, held) };
}

/** Sends the body. A provider that answers at once has its media stored here. */
export async function startGatewayRun(
  run: GatewayRun,
  credentials: GatewayCredentials,
  store: GatewayStore
): Promise<GatewayStarted> {
  const start = await GATEWAY_DRIVERS[run.provider]
    .start(run.target, run.input, credentials)
    .catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      const outcome = startOutcome(run, error);
      if (outcome === 'refused') throw new NonRetryableError(error.message);
      if (outcome === 'resend') throw new StartNotRun(error.message);
      throw error;
    });
  return 'jobId' in start
    ? { providerJobId: start.jobId }
    : {
        stored: await storeGatewayResult(heldResult(run, start.result), store),
      };
}

/** The provider answered the start without running it: the same key may send it again. */
export class StartNotRun extends Error {}

/**
 * How a start that threw ends: `refused` fails the job now; `resend` proves
 * nothing ran, so a retry may send it again; `unknown` may have reached the
 * provider, so a retry must not.
 */
function startOutcome(
  run: Pick<GatewayRun, 'provider' | 'target'>,
  error: Error
): 'refused' | 'resend' | 'unknown' {
  if (error instanceof NonRetryableError) return 'refused';
  const status =
    'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : null;
  if (status === null || status === 408 || status === 504) return 'unknown';
  if (status === 429) return 'resend';
  return GATEWAY_DRIVERS[run.provider].answersAtOnce(run.target.endpointId)
    ? 'resend'
    : 'refused';
}

/** One poll of a queued job; the poll that sees it finish stores its media. */
export async function pollGatewayRun(
  run: GatewayRun,
  providerJobId: string,
  credentials: GatewayCredentials,
  store: GatewayStore
): Promise<GatewayPolled> {
  const poll = await GATEWAY_DRIVERS[run.provider].poll(
    run.target,
    providerJobId,
    credentials
  );
  if (poll.status === 'failed') return { kind: 'failed', error: poll.error };
  if (poll.status === 'pending') return { kind: 'pending' };
  return {
    kind: 'stored',
    stored: await storeGatewayResult(heldResult(run, poll.result), store),
  };
}

/** Prices the card with the reported usage, charges the lines against the hold and marks the job succeeded. */
export async function settleGatewayRun(
  scopedDb: WorkflowScopedDb,
  run: GatewayRun,
  stored: GatewayStored,
  idempotencyKey: string
): Promise<Microdollars> {
  const usage = stored.usageJson
    ? usageSchema.parse(JSON.parse(stored.usageJson))
    : null;
  let cost = ZERO_MICROS;
  try {
    cost = priceGatewayJob(run.card, run.input, usage);
  } catch (error) {
    if (!(error instanceof RateCardError)) throw error;
    logger.warn(
      `Rate card refused the usage of gateway job ${run.jobId}: ${error.message}`
    );
  }
  return settleGatewayJob({
    scopedDb,
    jobId: run.jobId,
    model: `${run.provider}/${run.target.modelId}`,
    reservationId: run.reservationId,
    costMicros: cost,
    estimateMicros: run.estimateMicros,
    platformFeeBps: run.platformFeeBps,
    oauthClientId: run.oauthClientId,
    usedOwnKey: false,
    idempotencyKey,
    result: { outputs: stored.outputs, via: GATEWAY_VIA[run.provider] },
    metadata: {
      provider: run.provider,
      model: run.target.modelId,
      requestId: stored.requestId,
    },
  });
}

/** Records the outputs, then charges: a charged job always has its outputs. */
export async function finishGatewayRun(
  scopedDb: WorkflowScopedDb,
  run: GatewayRun,
  stored: GatewayStored,
  idempotencyKey: string
): Promise<Microdollars> {
  await scopedDb.gatewayJobs.recordOutputs(run.jobId, {
    outputs: stored.outputs,
    via: GATEWAY_VIA[run.provider],
  });
  const charged = await settleGatewayRun(scopedDb, run, stored, idempotencyKey);
  // A job's own hold gives back what the charge did not capture now, not at its TTL; a run's keeps it for the run.
  if (run.ownsReservation) {
    await scopedDb.billing.zeroReservation(run.reservationId);
  }
  return charged;
}

/** Ends a failed run: its own hold zeroed first (safe once the run is over), then the job failed; a charged job stays succeeded. */
export async function releaseGatewayRun(
  scopedDb: Pick<WorkflowScopedDb, 'billing' | 'gatewayJobs'>,
  run: Pick<GatewayRun, 'jobId' | 'reservationId' | 'ownsReservation'>,
  error: string
): Promise<void> {
  if (run.ownsReservation) {
    await scopedDb.billing.zeroReservation(run.reservationId);
  }
  await scopedDb.gatewayJobs.markFailed(run.jobId, {
    code: gatewayErrorCode(error),
    message: error,
  });
}
