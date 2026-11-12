/**
 * Settling a finished gateway job: the debit and its charge lines in one
 * batch (`billing.settleReservation`), then the job marked succeeded in the
 * same step, so a replay re-runs both and a charged job never reads failed.
 */

import {
  reportMissingBillingCost,
  reportSkippedDeduction,
} from '@/billing/billing-observability';
import { type Microdollars, ZERO_MICROS } from '@/billing/money';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { MediaVia } from '@/models/via';
import { gatewayCharge } from '@/gateway/charge-lines';
import type { AppMargin } from '@/gateway/server/user-pays';
import type { GatewayJobOutput } from '@/gateway/schema';
import { NonRetryableError } from 'cloudflare:workflows';

const WORKFLOW_NAME = 'GatewayGenerationWorkflow';

/** Charges the job's lines against its hold, marks it succeeded, and returns the debit. */
export async function settleGatewayJob(params: {
  scopedDb: WorkflowScopedDb;
  jobId: string;
  model: string;
  reservationId: string | undefined;
  /** What the provider billed; zero or less when it reported none. */
  costMicros: Microdollars;
  /** The provider estimate snapshotted at submit; charged when the provider reports no cost. */
  estimateMicros: Microdollars;
  /** The fee snapshotted at submit, so the charge matches the hold. */
  platformFeeBps: number;
  oauthClientId: string | null;
  /** The registered app the client was at submit. */
  appId?: string | null;
  /** The margin snapshotted at submit, so the charge matches the hold. */
  appMargin?: AppMargin | null;
  /** Must be false: a gateway job spends platform keys only. */
  usedOwnKey: boolean;
  /** Replay-stable, e.g. `${instanceId}:gateway-settle`. */
  idempotencyKey: string;
  result: { outputs: GatewayJobOutput[]; via: MediaVia };
  metadata?: Record<string, unknown>;
}): Promise<Microdollars> {
  const { scopedDb, jobId } = params;
  if (params.usedOwnKey) {
    throw new NonRetryableError(
      `Gateway job ${jobId} ran on an organization key`
    );
  }
  const unpriced = params.costMicros <= 0;
  if (unpriced) {
    reportMissingBillingCost({
      source: 'gateway-settle',
      modelId: params.model,
      workflowName: WORKFLOW_NAME,
      organizationId: scopedDb.organizationId,
      metadata: { gatewayJobId: jobId, estimateMicros: params.estimateMicros },
    });
  }
  const charge = gatewayCharge({
    providerCostMicros: unpriced ? params.estimateMicros : params.costMicros,
    platformFeeBps: params.platformFeeBps,
    ...(params.appMargin && { appMargin: params.appMargin }),
  });
  const description = `Gateway (${params.model})`;
  const metadata = {
    ...params.metadata,
    gatewayJobId: jobId,
    ...(unpriced && { chargedHold: true }),
  };
  const reportSkipped = (costMicros: Microdollars) => {
    reportSkippedDeduction({
      organizationId: scopedDb.organizationId,
      workflowName: WORKFLOW_NAME,
      description,
      costMicros,
      idempotencyKey: params.idempotencyKey,
      metadata,
    });
    void scopedDb.billing.checkAutoTopUp().catch(() => undefined);
  };

  let captured = ZERO_MICROS;
  if (!params.reservationId) {
    reportSkipped(charge.totalMicros);
  } else {
    const settled = await scopedDb.billing.settleReservation(
      params.reservationId,
      charge.lines,
      {
        idempotencyKey: params.idempotencyKey,
        description,
        metadata,
        attribution: {
          gatewayJobId: jobId,
          oauthClientId: params.oauthClientId,
          appId: params.appId ?? null,
        },
      }
    );
    if (!settled.ok) {
      reportSkipped(charge.totalMicros);
    } else {
      captured = settled.captured;
      if (settled.skippedDeltaMicros) reportSkipped(settled.skippedDeltaMicros);
    }
  }

  await scopedDb.gatewayJobs.markSucceeded(jobId, {
    ...params.result,
    costMicros: captured,
  });
  return captured;
}
