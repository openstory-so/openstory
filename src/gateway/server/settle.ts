/**
 * Settling a finished gateway job: one capture against the job's hold. PR 2
 * replaces the single capture with a debit plus charge lines written together.
 */

import type { Microdollars } from '@/billing/money';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { NonRetryableError } from 'cloudflare:workflows';

export async function settleGatewayJob(params: {
  scopedDb: WorkflowScopedDb;
  jobId: string;
  model: string;
  reservationId: string | undefined;
  costMicros: Microdollars;
  /** Must be false: a gateway job spends platform keys only. */
  usedOwnKey: boolean;
  /** Replay-stable, e.g. `${instanceId}:gateway-settle`. */
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (params.usedOwnKey) {
    throw new NonRetryableError(
      `Gateway job ${params.jobId} ran on an organization key`
    );
  }
  await deductWorkflowCredits({
    scopedDb: params.scopedDb,
    costMicros: params.costMicros,
    usedOwnKey: false,
    description: `Gateway (${params.model})`,
    idempotencyKey: params.idempotencyKey,
    reservationId: params.reservationId,
    metadata: { ...params.metadata, gatewayJobId: params.jobId },
    workflowName: 'GatewayGenerationWorkflow',
  });
}
