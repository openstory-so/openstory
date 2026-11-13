/**
 * `POST /api/v1/gateway/estimate/{provider}/{model}`: what a submit with this
 * body would hold, as lines, for this caller. Reserves nothing, writes nothing
 * and triggers nothing; the URLs in the body are not checked until the submit.
 */

import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import {
  gatewayEstimateDocument,
  type GatewayEstimateResource,
} from '@/gateway/server/api-documents';
import {
  chargeOnEstimate,
  priceGatewayRequest,
} from '@/gateway/server/submit-job';
import { resolveUserPays } from '@/gateway/server/user-pays';

export async function estimateGatewayJob(
  request: {
    provider: GatewayProvider;
    modelId: string;
    body: GatewayJobInput;
  },
  ctx: { scopedDb: ScopedDb; oauthClientId: string | null }
): Promise<GatewayEstimateResource> {
  const { model, estimate } = await priceGatewayRequest(request);
  const userPays = ctx.oauthClientId
    ? await resolveUserPays(ctx.scopedDb, ctx.oauthClientId)
    : null;
  const charge = chargeOnEstimate(estimate, userPays?.appMargin ?? null);
  return gatewayEstimateDocument({
    payer: userPays ? 'user' : 'app',
    provider: model.provider,
    model: model.id,
    kind: model.kind,
    totalMicros: charge.totalMicros,
    lines: charge.lines,
    remainingMicros: userPays?.standing.remainingMicros ?? null,
  });
}
