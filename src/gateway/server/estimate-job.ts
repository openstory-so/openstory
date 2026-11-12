/**
 * `POST /api/v1/gateway/jobs/estimate`: what a submit with this body would
 * hold, as lines, for this caller. Reserves nothing, writes nothing and
 * triggers nothing; the reference URLs are not checked until the submit.
 */

import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GatewayJobRequest } from '@/gateway/schema';
import {
  gatewayEstimateDocument,
  type GatewayEstimateResource,
} from '@/gateway/server/api-documents';
import { estimateGatewayJobCost } from '@/gateway/server/models';
import {
  assertServedModel,
  chargeOnEstimate,
  normalizeGatewayRequest,
} from '@/gateway/server/submit-job';
import { resolveUserPays } from '@/gateway/server/user-pays';

export async function estimateGatewayJob(
  request: GatewayJobRequest,
  ctx: { scopedDb: ScopedDb; oauthClientId: string | null }
): Promise<GatewayEstimateResource> {
  const input = normalizeGatewayRequest(request);
  assertServedModel(input);
  const userPays = ctx.oauthClientId
    ? await resolveUserPays(ctx.scopedDb, ctx.oauthClientId)
    : null;
  const charge = chargeOnEstimate(
    estimateGatewayJobCost(input, await getEffectiveFalPricing()),
    userPays?.appMargin ?? null
  );
  return gatewayEstimateDocument({
    payer: userPays ? 'user' : 'app',
    kind: input.kind,
    model: input.model,
    totalMicros: charge.totalMicros,
    lines: charge.lines,
    remainingMicros: userPays?.standing.remainingMicros ?? null,
  });
}
