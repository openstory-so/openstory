/**
 * Settling a finished gateway job: one capture against the job's hold. PR 2
 * replaces the single capture with a debit plus charge lines written together.
 */

import { reportMissingBillingCost } from '@/billing/billing-observability';
import type { Microdollars } from '@/billing/money';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { NonRetryableError } from 'cloudflare:workflows';

/** Captures the job's cost and returns what was charged: the hold when the provider reported none. */
export async function settleGatewayJob(params: {
  scopedDb: WorkflowScopedDb;
  jobId: string;
  model: string;
  reservationId: string | undefined;
  costMicros: Microdollars;
  /** The estimate held at submit; charged when the provider reports no cost. */
  holdMicros: Microdollars;
  /** Must be false: a gateway job spends platform keys only. */
  usedOwnKey: boolean;
  /** Replay-stable, e.g. `${instanceId}:gateway-settle`. */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}): Promise<Microdollars> {
  if (params.usedOwnKey) {
    throw new NonRetryableError(
      `Gateway job ${params.jobId} ran on an organization key`
    );
  }
  const unpriced = params.costMicros <= 0;
  const charge = unpriced ? params.holdMicros : params.costMicros;
  if (unpriced) {
    reportMissingBillingCost({
      source: 'gateway-settle',
      modelId: params.model,
      workflowName: 'GatewayGenerationWorkflow',
      organizationId: params.scopedDb.organizationId,
      metadata: { gatewayJobId: params.jobId, holdMicros: params.holdMicros },
    });
  }
  await deductWorkflowCredits({
    scopedDb: params.scopedDb,
    costMicros: charge,
    usedOwnKey: false,
    description: `Gateway (${params.model})`,
    idempotencyKey: params.idempotencyKey,
    reservationId: params.reservationId,
    metadata: {
      ...params.metadata,
      gatewayJobId: params.jobId,
      ...(unpriced && { chargedHold: true }),
    },
    workflowName: 'GatewayGenerationWorkflow',
  });
  return charge;
}
