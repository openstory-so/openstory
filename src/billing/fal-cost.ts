/**
 * Fal.ai cost calculation.
 *
 * Billing is exact: fal reports `unitsBilled` for each generation (the
 * `x-fal-billable-units` header) and the cost is `unitsBilled × unitPrice`
 * from the live `model_pricing` table — fal already accounts for resolution,
 * audio, duration, etc. in the unit count.
 *
 * `estimateFalCost` predicts a cost BEFORE a generation runs, for the
 * pre-flight credit gate. Precedence (#1605 / #1069):
 *
 * 1. A **verified rate card** evaluated against the request the caller is
 *    about to send, times its calibration once enough observations back it.
 * 2. Our observed median unit count (`MIN_OBSERVED_SAMPLES`+ generations).
 * 3. fal's historical estimate.
 * 4. **null** ("unknown") — never a fabricated default, never an advertised
 *    USD against a $1 catalog stub, never a sibling's price. Callers gate
 *    conservatively / display nothing for null.
 */

// Type-only: the live pricing reader is server-only (D1). `falCostFromUnits`
// (the billing half) lives in `@/billing/server/fal-cost-billing`.
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { evaluateRateCard, RateCardError } from './rate-card/evaluate';
import { type Microdollars, multiplyMicros, usdToMicros } from './money';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'ai', 'fal-cost']);

export type { EffectiveFalPricing };

/**
 * Observations needed before our own median outranks fal's historical
 * estimate — a single unrepresentative sample would under-gate by orders of
 * magnitude. The same bar applies to a rate card's calibration.
 */
export const MIN_OBSERVED_SAMPLES = 5;

// ============================================================================
// Pre-flight estimation — predicts a unit count from generation params
// ============================================================================

export type FalCostEstimateParams = {
  numImages?: number;
  durationSeconds?: number;
  widthPx?: number;
  heightPx?: number;
  resolution?: string;
  /**
   * The provider request body this estimate stands in for — the built fal
   * input where the caller has one, else the levers it knows spelled with
   * the endpoint's own param names (`duration`, `resolution`, `image_size`).
   * A verified rate card is evaluated against it; without it the card is
   * skipped rather than priced at defaults the caller never chose.
   */
  request?: Record<string, unknown>;
};

/**
 * How estimation predicts a unit count for an endpoint without a card.
 * Parametric strategies compute from request params; `per_call` uses the
 * observed/historical units per call. Billing never reads this — it only
 * multiplies `unitsBilled`.
 */
type EstimateStrategy = 'per_call' | 'megapixels' | 'seconds' | 'minutes';

/**
 * Endpoints whose raw unit ("units") doesn't identify the estimation shape.
 */
const ENDPOINT_STRATEGY: Record<string, EstimateStrategy> = {
  'fal-ai/ace-step-1.5': 'seconds',
};

/**
 * Exact matches for the duration units, deliberately: fal's catalog also
 * reports "compute seconds", "5 seconds", "input seconds" — none of which are
 * the requested duration, and a wrong branch is off by orders of magnitude
 * (#1069). Everything unrecognised (including the token-billed Seedance
 * endpoints, whose formula now lives in their rate card) estimates per call,
 * which reports unknown until a signal exists.
 */
export function estimateStrategy(
  endpointId: string,
  rawUnit: string
): EstimateStrategy {
  const override = ENDPOINT_STRATEGY[endpointId];
  if (override) return override;
  const unit = rawUnit.trim().toLowerCase();
  if (unit.includes('megapixel')) return 'megapixels';
  if (unit === 'seconds' || unit === 'second') return 'seconds';
  if (unit === 'minutes' || unit === 'minute') return 'minutes';
  return 'per_call';
}

const isUsableCount = (n: number | undefined | null): n is number =>
  n != null && Number.isFinite(n) && n > 0;

function trustedObservedUnits(
  pricing: EffectiveFalPricing
): number | undefined {
  const { observed } = pricing;
  if (
    observed &&
    observed.sampleCount >= MIN_OBSERVED_SAMPLES &&
    isUsableCount(observed.medianUnits)
  ) {
    return observed.medianUnits;
  }
  return undefined;
}

/**
 * Predicted unitsBilled for one call: our observed median first (once it has
 * `MIN_OBSERVED_SAMPLES` behind it), then fal's historical estimate.
 */
export function knownUnitsPerCall(
  pricing: EffectiveFalPricing
): number | undefined {
  const observed = trustedObservedUnits(pricing);
  if (observed != null) return observed;
  if (isUsableCount(pricing.typicalUnitsPerCall)) {
    return pricing.typicalUnitsPerCall;
  }
  return undefined;
}

/**
 * The verified card's USD for this request, times its calibration.
 *
 * Calibration maths: the hourly reconcile replays every recent observation
 * that recorded its request levers through the same card and takes the
 * median of `actual / card`, where `actual = unitsBilled × verified
 * unitPrice`. That median is the multiplier — computed over the requests
 * users really sent, not over one default shape — so a card that is
 * systematically 5% under (fal's "roughly" per-second figures) or reads a
 * promo that ended becomes calibrated rather than replaced. Below
 * `MIN_OBSERVED_SAMPLES` the multiplier is 1.
 *
 * Null when the card cannot stand behind a number: unverified, past its
 * promo end, or refusing the request (a size the table does not price). The
 * caller then falls through to the unit-count signals; a refusal is logged
 * because it usually means a lever the card should bind.
 */
function rateCardEstimate(
  endpointId: string,
  pricing: EffectiveFalPricing,
  request: Record<string, unknown>
): Microdollars | null {
  const rateCard = pricing.rateCard;
  if (!rateCard?.verified) return null;
  const { expiresAt } = rateCard.card.source;
  if (expiresAt != null && new Date(expiresAt) <= new Date()) return null;
  try {
    const { usd } = evaluateRateCard(rateCard.card, request);
    const calibration = pricing.rateCardCalibration;
    const factor =
      calibration && calibration.sampleCount >= MIN_OBSERVED_SAMPLES
        ? calibration.ratio
        : 1;
    return usdToMicros(usd * factor);
  } catch (error) {
    logger.warn(
      `${endpointId}: rate card refused the request — estimating from unit counts`,
      {
        reason:
          error instanceof RateCardError
            ? `${error.code}: ${error.message}`
            : String(error),
      }
    );
    return null;
  }
}

/**
 * Rough pre-flight cost estimate for the credit gate. Returns **null when no
 * honest estimate exists** — unknown endpoint, or a per-call endpoint with no
 * unit-count signal yet. `pricingMap` is required so a call site cannot
 * silently estimate on stale data: pass `getEffectiveFalPricing()` on server
 * paths, or an explicit fixture in tests.
 */
export function estimateFalCost(
  endpointId: string,
  params: FalCostEstimateParams,
  pricingMap: Record<string, EffectiveFalPricing>
): Microdollars | null {
  const pricing = pricingMap[endpointId];
  if (!pricing) {
    logger.error(`No fal pricing data for endpoint: ${endpointId}`);
    return null;
  }

  if (params.request) {
    const carded = rateCardEstimate(endpointId, pricing, params.request);
    if (carded !== null) return carded;
  }

  const numImages = params.numImages ?? 1;
  const duration = params.durationSeconds ?? 0;

  switch (estimateStrategy(endpointId, pricing.unit)) {
    case 'per_call': {
      // Covers flat rates, per-image "units" prices (gpt-image-2 bills ~0.22
      // units per image on a $1 unit), and compute-seconds models (~10 to
      // ~294 s/image across models — unknowable from request params).
      const unitsPerCall = knownUnitsPerCall(pricing);
      if (unitsPerCall != null) {
        return multiplyMicros(pricing.unitPrice, unitsPerCall * numImages);
      }
      // Catalog stub (Lite: "units" × $1, no typical). Do not multiply the
      // stub price and do not substitute advertised USD — billing still uses
      // unitsBilled × live unitPrice, and a $0.04 gate against a $1 unit
      // under-charges ~25×. Null → gateEstimate $0.10 floor (#1069).
      logger.error(
        `No unit-count signal for ${endpointId} (unit "${pricing.unit}") — ` +
          'estimate unknown (returns once a generation records unitsBilled)'
      );
      return null;
    }

    case 'megapixels': {
      const w = params.widthPx ?? 1024;
      const h = params.heightPx ?? 1024;
      const megapixels = (w * h) / 1_000_000;
      return multiplyMicros(pricing.unitPrice, megapixels * numImages);
    }

    case 'seconds': {
      // Wall-clock duration is 1:1 for models like Veo. An endpoint that
      // bills more units than seconds (H3 Max 768P is 1.6× its 480p unit)
      // shows up in the observed median, which outranks duration. Fal's
      // historical typical is an average clip length and must not replace
      // the requested duration.
      const observed = trustedObservedUnits(pricing);
      return multiplyMicros(
        pricing.unitPrice,
        observed != null ? Math.max(duration, observed) : duration
      );
    }

    case 'minutes':
      return multiplyMicros(pricing.unitPrice, Math.ceil(duration / 60));
  }
}
