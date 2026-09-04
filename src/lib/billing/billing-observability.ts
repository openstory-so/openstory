/**
 * Observability for billing gaps — when a completed AI call reports no cost.
 *
 * PostHog capture goes through `createIsomorphicFn` so the Generate CTA can
 * floor an unpriced motion/audio line on every keystroke without calling
 * `getPostHogClient()` in the browser (#1354). That helper is
 * `createServerOnlyFn` — the client stub throws
 * `createServerOnlyFn() functions can only be called on the server!`.
 * Server credit-gates still emit; the UI path is a no-op.
 */

import { getPostHogClient } from '@/lib/posthog-server';
import { getLogger } from '@/lib/observability/logger';
import { createIsomorphicFn } from '@tanstack/react-start';

const logger = getLogger(['openstory', 'billing', 'missing-cost']);

type BillingCapture = {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
};

const captureBillingEvent = createIsomorphicFn()
  .client((_payload: BillingCapture) => {
    // Browser: posthog-node must not run. Server gates still capture.
  })
  .server((payload: BillingCapture) => {
    getPostHogClient()?.capture(payload);
  });

export type MissingBillingCostContext = {
  source: string;
  modelId?: string;
  workflowName?: string;
  description?: string;
  teamId?: string;
  metadata?: Record<string, unknown>;
};

export type FlooredEstimateContext = {
  model: string;
  operation: string;
  numCalls: number;
  floorMicros: number;
};

/**
 * Emit analytics when the credit gate substitutes the unknown-estimate floor
 * for a model it cannot price.
 *
 * Fires on **every** substitution, unlike `gateEstimate`'s log, which dedupes
 * per isolate to survive per-shot loops. The rate is the whole point: #1069
 * went unnoticed for months because a fabricated estimate produced no signal
 * anyone could count, and a floored gate is the same shape of unknown.
 */
export function reportFlooredEstimate(ctx: FlooredEstimateContext): void {
  captureBillingEvent({
    distinctId: 'system',
    event: 'billing_estimate_floored',
    properties: {
      model: ctx.model,
      operation: ctx.operation,
      num_calls: ctx.numCalls,
      floor_micros: ctx.floorMicros,
    },
  });
}

export type BillingDriftContext = {
  teamId: string;
  transactionId: string;
  requestId: string;
  endpointId: string;
  chargedMicros: number;
  billedMicros: number;
};

/**
 * A charge disagrees with fal's per-request bill (hourly reconcile).
 * Report-only for now — deltas are not settled back to the ledger.
 */
export function reportBillingDrift(ctx: BillingDriftContext): void {
  logger.error('charge disagrees with fal billed cost', ctx);

  captureBillingEvent({
    distinctId: ctx.teamId,
    event: 'billing_drift',
    properties: {
      transaction_id: ctx.transactionId,
      request_id: ctx.requestId,
      endpoint_id: ctx.endpointId,
      charged_micros: ctx.chargedMicros,
      billed_micros: ctx.billedMicros,
      delta_micros: ctx.billedMicros - ctx.chargedMicros,
    },
  });
}

export type SkippedDeductionContext = {
  teamId?: string;
  workflowName?: string;
  description?: string;
  costMicros: number;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

export type ReservationShortContext = {
  teamId?: string;
  sequenceId?: string;
  neededMicros: number;
  remainingMicros: number;
  sceneCount: number;
};

/**
 * Grow after scene-split failed: stills/motion will not spawn. The split,
 * bibles, and prompts stay. Emitted so a shortfall is queryable (#1310).
 */
export function reportReservationShort(ctx: ReservationShortContext): void {
  logger.warn(
    'Storyboard reservation could not grow to cover remaining work',
    ctx
  );

  captureBillingEvent({
    distinctId: ctx.teamId ?? 'system',
    event: 'billing_reservation_short',
    properties: {
      sequence_id: ctx.sequenceId,
      needed_micros: ctx.neededMicros,
      remaining_micros: ctx.remainingMicros,
      scene_count: ctx.sceneCount,
    },
  });
}

/**
 * Generation ran but some or all of the cost was not posted: missing hold,
 * capture short of actual, or posted-balance tryDeduct refused. Emitted so
 * unbilled spend is a queryable metric rather than a log grep.
 */
export function reportSkippedDeduction(ctx: SkippedDeductionContext): void {
  logger.warn('Completed AI generation skipped deduction', ctx);

  captureBillingEvent({
    distinctId: ctx.teamId ?? 'system',
    event: 'billing_skipped_deduction',
    properties: {
      workflow_name: ctx.workflowName,
      description: ctx.description,
      cost_micros: ctx.costMicros,
      idempotency_key: ctx.idempotencyKey,
      ...ctx.metadata,
    },
  });
}

/** Log and emit analytics when a completed generation has nothing to bill. */
export function reportMissingBillingCost(ctx: MissingBillingCostContext): void {
  logger.warn('Completed AI generation with no billable cost reported', ctx);

  captureBillingEvent({
    distinctId: ctx.teamId ?? 'system',
    event: 'billing_missing_cost',
    properties: {
      source: ctx.source,
      model_id: ctx.modelId,
      workflow_name: ctx.workflowName,
      description: ctx.description,
      ...ctx.metadata,
    },
  });
}
