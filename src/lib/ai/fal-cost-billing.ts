/**
 * Exact fal cost for a completed generation — the server half of
 * `@/shared/ai/fal-cost`. It reads live `model_pricing` from D1, which is
 * why it lives in `src/lib` while the pre-flight estimator stays client-safe.
 */

import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import type { EffectiveFalPricing } from '@/shared/ai/fal-cost';
import { reportMissingBillingCost } from '@/shared/billing/billing-observability';
import {
  type Microdollars,
  ZERO_MICROS,
  multiplyMicros,
} from '@/shared/billing/money';
import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'ai', 'fal-cost']);

/**
 * Returns `ZERO_MICROS` (reported via `reportMissingBillingCost`) when pricing
 * is missing, unreadable, or fal did not report `unitsBilled` — we charge
 * nothing rather than guess.
 *
 * Never throws: it runs inside retried workflow steps after fal has billed,
 * and a rejection there discards a finished asset and pays fal again on the
 * retry. Tests pass `pricingMap` to skip D1.
 */
export async function falCostFromUnits(
  endpointId: string,
  unitsBilled: number | undefined,
  pricingMap?: Record<string, EffectiveFalPricing>
): Promise<Microdollars> {
  let pricing: EffectiveFalPricing | undefined;
  try {
    pricing = (pricingMap ?? (await getEffectiveFalPricing()))[endpointId];
  } catch (err) {
    logger.error(`Failed to read live pricing for ${endpointId}`, {
      err,
      endpointId,
      unitsBilled,
    });
  }
  if (!pricing) {
    return reportZeroCharge(endpointId, 'no pricing for endpoint', unitsBilled);
  }
  if (unitsBilled == null || !Number.isFinite(unitsBilled)) {
    return reportZeroCharge(endpointId, 'no unitsBilled reported', unitsBilled);
  }
  return multiplyMicros(pricing.unitPrice, unitsBilled);
}

function reportZeroCharge(
  endpointId: string,
  reason: string,
  unitsBilled: number | undefined
): Microdollars {
  reportMissingBillingCost({
    source: 'fal-cost',
    modelId: endpointId,
    description: reason,
    metadata: { unitsBilled },
  });
  return ZERO_MICROS;
}
