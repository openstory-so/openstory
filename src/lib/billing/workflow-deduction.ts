/**
 * Workflow credit deduction. Skips BYOK teams; warns and skips (rather than
 * throwing) on insufficient credits, since the work is already done.
 *
 * When the payload carries a `reservationId` (run envelope, #1310), capture
 * posts usage against that hold. Otherwise `tryDeductCredits` charges posted
 * balance. A missing hold or a short capture reports the unbilled remainder.
 *
 * Pricing observations are deliberately NOT recorded here: call sites guard
 * deduction behind `cost > 0 && !usedOwnKey`, so a recorder inside this
 * function would never see the BYOK/unpriced generations whose units we most
 * need (#1069). Use `recordFalUsage` in its own workflow step instead.
 */

import { isBytePlusPricedModel } from '@/lib/ai/byteplus-pricing';
import {
  isNativeGrokImageEndpoint,
  NATIVE_GROK_VIDEO_MODEL,
} from '@/lib/ai/grok-native';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ModelPricingProvider } from '@/lib/db/schema/model-pricing';
import {
  reportMissingBillingCost,
  reportSkippedDeduction,
} from './billing-observability';
import { type Microdollars, microsToUsd, ZERO_MICROS } from './money';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'billing', 'workflow-deduction']);

type WorkflowDeductionOpts = {
  /** Scoped DB context for the team. Skips deduction if undefined (e.g., anonymous workflows). */
  scopedDb: WorkflowScopedDb | undefined;
  costMicros: Microdollars;
  /** Set to true if the team used their own API key for this generation */
  usedOwnKey: boolean;
  description: string;
  /**
   * Stable key making this deduction idempotent across `step.do` retries.
   * Convention: `${event.instanceId}:<charge-name>` — the workflow instance
   * id is replay-stable, so a retried step recovers the original transaction
   * instead of double-charging the team.
   */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  /** Workflow name for the logger.warn prefix (e.g., "VariantWorkflow") */
  workflowName?: string;
  /** Run envelope created at the HTTP trigger. Capture against it when set. */
  reservationId?: string;
};

function logPrefix(workflowName: string | undefined): string {
  return workflowName ? `[${workflowName}]` : '[Workflow]';
}

function skipDeduction(
  scopedDb: WorkflowScopedDb,
  opts: WorkflowDeductionOpts
): void {
  const prefix = logPrefix(opts.workflowName);
  logger.warn(
    `${prefix} Insufficient credits (cost: $${microsToUsd(opts.costMicros).toFixed(4)}), skipping deduction`
  );
  reportSkippedDeduction({
    teamId: scopedDb.teamId,
    workflowName: opts.workflowName,
    description: opts.description,
    costMicros: opts.costMicros,
    idempotencyKey: opts.idempotencyKey,
    metadata: opts.metadata,
  });
  void scopedDb.billing.checkAutoTopUp().catch((err) => {
    logger.error('Failed:', { err });
  });
}

/**
 * Deduct credits for a completed workflow generation. A `costMicros <= 0` is
 * reported as a pricing bug, not treated as a free call; insufficient credits
 * warn, skip, and fire an auto-top-up attempt.
 *
 * When `reservationId` is set, capture against that envelope. Otherwise
 * atomic deduct of posted balance.
 */
export async function deductWorkflowCredits(
  opts: WorkflowDeductionOpts
): Promise<void> {
  if (!opts.scopedDb) return;
  const { scopedDb } = opts;

  if (opts.usedOwnKey) return;

  if (opts.costMicros <= 0) {
    reportMissingBillingCost({
      source: 'workflow-deduction',
      workflowName: opts.workflowName,
      description: opts.description,
      metadata: opts.metadata,
      teamId: scopedDb.teamId,
    });
    return;
  }

  if (opts.reservationId) {
    const captured = await scopedDb.billing.captureReservation(
      opts.reservationId,
      opts.costMicros,
      {
        description: opts.description,
        metadata: opts.metadata,
        idempotencyKey: opts.idempotencyKey,
      }
    );
    if (!captured.ok) {
      skipDeduction(scopedDb, opts);
      return;
    }
    if (captured.skippedDeltaMicros) {
      skipDeduction(scopedDb, {
        ...opts,
        costMicros: captured.skippedDeltaMicros,
      });
    }
    return;
  }

  const debit = await scopedDb.billing.tryDeductCredits(opts.costMicros, {
    description: opts.description,
    metadata: opts.metadata,
    idempotencyKey: opts.idempotencyKey,
  });
  if (!debit.ok) {
    skipDeduction(scopedDb, opts);
  }
}

/**
 * Extract the cost from a fal.ai generation result's metadata.
 * Returns ZERO_MICROS if missing. Cost is already in Microdollars,
 * computed from fal's reported billed units (see `falCostFromUnits`).
 */
export function extractImageCost(metadata: {
  cost?: Microdollars;
}): Microdollars {
  return metadata.cost ?? ZERO_MICROS;
}

/**
 * What one fal call billed. `numImages` matters because `unitsBilled` is per
 * *call* while estimation works per image — the median divides by it.
 */
export type FalUsage = {
  endpointId: string;
  unitsBilled?: number;
  numImages?: number;
  /**
   * fal's request id — joins this charge to its `/v1/models/billing-events`
   * record, the per-request billed cost the hourly reconcile audits against.
   */
  requestId?: string;
  /**
   * Which API billed this (#1157). Observations are keyed by
   * (provider, endpointId), so a BytePlus sample filed under 'fal' would
   * pollute the fal endpoint's median with a different denomination.
   *
   * Named `billingProvider`, not `provider`: callers spread whole generation
   * metadata objects in here, and those already carry a `provider` meaning the
   * LAB ("ElevenLabs", "ByteDance"). A bare `provider` would capture it
   * silently and file every music sample under a nonexistent provider.
   */
  billingProvider?: ModelPricingProvider;
};

/**
 * Narrow a generation result's metadata to the usage fields. The result feeds
 * both the observation write (`recordFalUsage`) and the credit transaction's
 * metadata, so a charge can be traced back to the units behind it.
 */
function falUsageMetadata(metadata: FalUsage): FalUsage {
  return {
    endpointId: metadata.endpointId,
    unitsBilled: metadata.unitsBilled,
    numImages: metadata.numImages,
    requestId: metadata.requestId,
    billingProvider: metadata.billingProvider,
  };
}

/**
 * Persist one usage sample for the pricing cron's observed median (#1069).
 * Call for **every** fal generation — BYOK and unpriced ones included; an
 * unpriced model has no other route off `UNKNOWN_ESTIMATE_FLOOR`. Errors
 * propagate: the caller's `step.do` retries only this insert, never the fal
 * call.
 */
export async function recordFalUsage(
  scopedDb: WorkflowScopedDb | undefined,
  usage: FalUsage
): Promise<void> {
  // Observations are platform-global telemetry with no teamId (see
  // model_usage_observations), but the write still needs a db handle.
  if (!scopedDb) return;
  // Native xAI / Ark units are a different denomination — sampling them
  // under a fal endpoint id would corrupt the median the pricing cron
  // reads (#1167 / #1157 / #1069).
  if (
    isNativeGrokImageEndpoint(usage.endpointId) ||
    usage.endpointId === NATIVE_GROK_VIDEO_MODEL ||
    isBytePlusPricedModel(usage.endpointId)
  ) {
    return;
  }
  const { unitsBilled } = usage;
  if (
    unitsBilled == null ||
    !Number.isFinite(unitsBilled) ||
    unitsBilled <= 0
  ) {
    // Named, because an endpoint that never reports unitsBilled never earns a
    // median and sits on the estimate floor forever, while the refresh cron
    // reports a healthy `observedEndpoints` count. Silence here makes "cold"
    // and "broken" identical.
    logger.warn('fal generation reported no usable unitsBilled — no sample', {
      endpointId: usage.endpointId,
      unitsBilled,
    });
    return;
  }
  await scopedDb.modelUsage.record({
    provider: usage.billingProvider ?? 'fal',
    endpointId: usage.endpointId,
    unitsBilled,
    numImages: usage.numImages,
  });
}

/**
 * Record one fal usage sample in its own workflow step, BEFORE any
 * `cost > 0 && !usedOwnKey` deduction guard. The separate step makes the
 * insert replay-safe. Returns the narrowed usage so the caller can spread it
 * into the deduction's transaction metadata.
 */
export async function recordFalUsageStep(
  step: { do: (name: string, fn: () => Promise<void>) => Promise<void> },
  scopedDb: WorkflowScopedDb | undefined,
  metadata: FalUsage,
  stepName = 'record-fal-usage'
): Promise<FalUsage> {
  const usage = falUsageMetadata(metadata);
  await step.do(stepName, async () => {
    await recordFalUsage(scopedDb, usage);
  });
  return usage;
}
