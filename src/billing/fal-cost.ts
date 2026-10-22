/**
 * Fal.ai cost calculation.
 *
 * Billing is exact: fal reports `unitsBilled` for each generation (the
 * `x-fal-billable-units` header) and the cost is `unitsBilled × unitPrice`
 * from the live `model_pricing` table — fal already accounts for resolution,
 * audio, duration, etc. in the unit count.
 *
 * `estimateFalCost` predicts a cost BEFORE a generation runs, for the
 * pre-flight credit gate. Preference order (#1605, updating #1069):
 * our observed median (`MIN_OBSERVED_SAMPLES`+ generations), then the
 * stored modelschemas rate card evaluated against the request we are about
 * to send, then fal's historical typical units (and the unit formula for
 * endpoints that have no card yet), then **null**. A card that refuses
 * returns null — it does not fall through to a sibling price or a $1 stub.
 * Billing never reads the card. Callers gate conservatively / display
 * nothing for null.
 */

import {
  cardParams,
  evaluateCard,
  RateCardError,
  type RateCard,
} from '@modelschemas/rate-card/evaluator';
// Type-only: the live pricing reader is server-only (D1). `falCostFromUnits`
// (the billing half) lives in `@/billing/server/fal-cost-billing`.
import type { EffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP,
  TYPICAL_VIDEO_CLIP_SECONDS,
} from './fal-typical-units';
import { type Microdollars, multiplyMicros, usdToMicros } from './money';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'ai', 'fal-cost']);

export type { EffectiveFalPricing };

/**
 * Observations needed before our own median outranks fal's historical
 * estimate — a single unrepresentative sample would under-gate by orders of
 * magnitude.
 */
export const MIN_OBSERVED_SAMPLES = 5;

/** Assumed 16:9 output dimensions per resolution tier for token-priced models */
const TOKEN_RESOLUTION_DIMENSIONS: Record<
  string,
  { width: number; height: number }
> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

/**
 * fal Seedance (and similar token-billed video endpoints) default to 720p
 * when the client omits `resolution`. Defaulting to 1080p here overstated
 * pre-flight costs by ~2.2× (#1140).
 */
const DEFAULT_TOKEN_RESOLUTION = '720p';

// ============================================================================
// Pre-flight estimation — predicts a unit count from generation params
// ============================================================================

export type FalCostEstimateParams = {
  /**
   * The request body we are about to send, or the levers a pre-flight gate
   * already knows (`resolution`, `num_images`). Request-bound card inputs
   * read this.
   */
  request?: object;
  /**
   * Usage-bound levers known before the call (a video `duration` when the
   * card binds it as usage). Keys the card does not read are dropped.
   */
  usage?: Record<string, unknown>;
  /** Formula fallback when no card is stored. */
  numImages?: number;
  durationSeconds?: number;
  widthPx?: number;
  heightPx?: number;
  fps?: number;
  resolution?: string;
};

/**
 * How estimation predicts a unit count for an endpoint. Parametric strategies
 * compute from request params; `per_call` uses the observed/historical units
 * per call. Billing never reads this — it only multiplies `unitsBilled`.
 */
type EstimateStrategy =
  | 'per_call'
  | 'megapixels'
  | 'seconds'
  | 'minutes'
  | 'tokens';

/**
 * Endpoints whose raw unit ("units") doesn't identify the estimation shape.
 */
const ENDPOINT_STRATEGY: Record<string, EstimateStrategy> = {
  'fal-ai/ace-step-1.5': 'seconds',
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': 'tokens',
  'bytedance/seedance-2.0/enterprise/v2/reference-to-video': 'tokens',
  'bytedance/seedance-2.0/enterprise/v2/text-to-video': 'tokens',
  'bytedance/seedance-2.5/image-to-video': 'tokens',
  'bytedance/seedance-2.5/reference-to-video': 'tokens',
  'bytedance/seedance-2.5/text-to-video': 'tokens',
  'bytedance/seedance-2.0/mini/image-to-video': 'tokens',
  'bytedance/seedance-2.0/mini/reference-to-video': 'tokens',
  'bytedance/seedance-2.0/mini/text-to-video': 'tokens',
};

/**
 * Exact matches for the duration units, deliberately: fal's catalog also
 * reports "compute seconds", "5 seconds", "input seconds" — none of which are
 * the requested duration, and a wrong branch is off by orders of magnitude
 * (#1069). Everything unrecognised estimates per call, which reports unknown
 * until a signal exists.
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
  if (unit === '1000 tokens') return 'tokens';
  return 'per_call';
}

const isUsableCount = (n: number | undefined | null): n is number =>
  n != null && Number.isFinite(n) && n > 0;

/**
 * Predicted unitsBilled for one call: our observed median first (once it has
 * `MIN_OBSERVED_SAMPLES` behind it), then fal's historical estimate, then a
 * known billed-units fallback (H3 Max 8 for a 5s clip — #1382).
 */
export function knownUnitsPerCall(
  pricing: EffectiveFalPricing,
  endpointId?: string
): number | undefined {
  const { observed } = pricing;
  if (
    observed &&
    observed.sampleCount >= MIN_OBSERVED_SAMPLES &&
    isUsableCount(observed.medianUnits)
  ) {
    return observed.medianUnits;
  }
  if (isUsableCount(pricing.typicalUnitsPerCall)) {
    return pricing.typicalUnitsPerCall;
  }
  const fallback = endpointId
    ? FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP[endpointId]
    : undefined;
  return isUsableCount(fallback) ? fallback : undefined;
}

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
 * Predicted billable units for a seconds-priced video call.
 *
 * Wall-clock duration is 1:1 for models like Veo. H3 Max (and any endpoint
 * in `FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP`) bills more units than seconds —
 * 768P is 1.6× the stored 480p unit — so observed/typical/fallback outranks
 * duration and scales from a 5s default clip (#1382).
 *
 * Fal's historical `typicalUnitsPerCall` for ordinary per-second models is
 * an average clip length and must not replace the requested duration.
 */
function predictedSecondUnits(
  endpointId: string,
  duration: number,
  pricing: EffectiveFalPricing
): number {
  const observedUnits = trustedObservedUnits(pricing);
  const fallback = FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP[endpointId];

  if (fallback != null) {
    const known =
      observedUnits ??
      (isUsableCount(pricing.typicalUnitsPerCall)
        ? pricing.typicalUnitsPerCall
        : fallback);
    return Math.max(duration, known * (duration / TYPICAL_VIDEO_CLIP_SECONDS));
  }

  if (observedUnits != null) {
    return Math.max(duration, observedUnits);
  }
  return duration;
}

/**
 * Put each known lever where this card reads it. A usage key the card does
 * not read would throw `unknown-usage-key` and look like a refusal. A
 * request key it does not read is ignored by the evaluator.
 */
function inputsForCard(
  card: RateCard,
  request: Record<string, unknown>,
  usage: Record<string, unknown>
): { request: Record<string, unknown>; usage: Record<string, unknown> } {
  const bound = cardParams(card);
  const placedUsage: Record<string, unknown> = {};
  for (const key of bound.usage) {
    if (Object.prototype.hasOwnProperty.call(usage, key)) {
      placedUsage[key] = usage[key];
    } else if (Object.prototype.hasOwnProperty.call(request, key)) {
      placedUsage[key] = request[key];
    }
  }
  const placedRequest = { ...request };
  for (const key of bound.request) {
    if (
      !Object.prototype.hasOwnProperty.call(placedRequest, key) &&
      Object.prototype.hasOwnProperty.call(usage, key)
    ) {
      placedRequest[key] = usage[key];
    }
  }
  return { request: placedRequest, usage: placedUsage };
}

function plainRecord(value: object | undefined): Record<string, unknown> {
  if (!value) return {};
  return { ...value };
}

/**
 * Levers the gate knows, spelled so a card can read them, without
 * overwriting a field already on the built request.
 */
function knownLevers(params: FalCostEstimateParams): {
  request: Record<string, unknown>;
  usage: Record<string, unknown>;
} {
  const request = plainRecord(params.request);
  const usage = { ...params.usage };
  if (params.resolution != null && request.resolution == null) {
    request.resolution = params.resolution;
  }
  if (params.numImages != null && request.num_images == null) {
    request.num_images = params.numImages;
  }
  if (
    params.durationSeconds != null &&
    usage.duration == null &&
    request.duration == null
  ) {
    usage.duration = params.durationSeconds;
  }
  return { request, usage };
}

/**
 * Evaluate the stored card. `null` is a refusal (warn, do not fall through).
 */
function estimateFromCard(
  endpointId: string,
  card: RateCard,
  params: FalCostEstimateParams
): Microdollars | null {
  const known = knownLevers(params);
  const inputs = inputsForCard(card, known.request, known.usage);
  try {
    const { amount, currency } = evaluateCard(card, inputs);
    if (currency !== 'USD' || !(amount > 0)) {
      logger.warn(
        `Rate card for ${endpointId} refused a price — estimate unknown`,
        { endpointId, currency, amount }
      );
      return null;
    }
    return usdToMicros(amount);
  } catch (err) {
    const code = err instanceof RateCardError ? err.code : undefined;
    logger.warn(
      `Rate card for ${endpointId} refused a price — estimate unknown`,
      { endpointId, code, err }
    );
    return null;
  }
}

/**
 * Rough pre-flight cost estimate for the credit gate. Returns **null when no
 * honest estimate exists** — unknown endpoint, a card that refuses, or a
 * per-call endpoint with no unit-count signal yet. `pricingMap` is required
 * so a call site cannot silently estimate on stale data: pass
 * `getEffectiveFalPricing()` on server paths, or an explicit fixture in tests.
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

  // Observed median outranks the card. A card with no median is the
  // estimate; a refusal stays null rather than borrowing another price.
  if (pricing.rateCard && trustedObservedUnits(pricing) == null) {
    return estimateFromCard(endpointId, pricing.rateCard, params);
  }

  const numImages = params.numImages ?? 1;
  const duration = params.durationSeconds ?? 0;

  switch (estimateStrategy(endpointId, pricing.unit)) {
    case 'per_call': {
      // Covers flat rates, per-image "units" prices (gpt-image-2 bills ~0.22
      // units per image on a $1 unit), and compute-seconds models (~10 to
      // ~294 s/image across models — unknowable from request params).
      const unitsPerCall = knownUnitsPerCall(pricing, endpointId);
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

    case 'seconds':
      return multiplyMicros(
        pricing.unitPrice,
        predictedSecondUnits(endpointId, duration, pricing)
      );

    case 'minutes':
      return multiplyMicros(pricing.unitPrice, Math.ceil(duration / 60));

    case 'tokens': {
      // fal: tokens = (h × w × duration × fps) / 1024, billed per 1000 tokens
      // (Seedance docs). Prefer explicit width/height, else resolution tier,
      // else the platform default (720p — not 1080p).
      const tier =
        params.resolution && TOKEN_RESOLUTION_DIMENSIONS[params.resolution]
          ? params.resolution
          : DEFAULT_TOKEN_RESOLUTION;
      const dims = TOKEN_RESOLUTION_DIMENSIONS[tier] ?? {
        width: 1280,
        height: 720,
      };
      const w = params.widthPx ?? dims.width;
      const h = params.heightPx ?? dims.height;
      const fps = params.fps ?? 24;
      // ~5% overhead vs the nominal formula — matches observed billable units
      // slightly above the pure geometric product on real generations.
      const units = ((w * h * fps * duration) / 1024 / 1000) * 1.05;
      return multiplyMicros(pricing.unitPrice, units);
    }
  }
}
