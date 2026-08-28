/**
 * Fal.ai cost calculation.
 *
 * Billing is exact: fal reports `unitsBilled` for each generation (the
 * `x-fal-billable-units` header) and the cost is `unitsBilled × unitPrice`
 * from the live `model_pricing` table — fal already accounts for resolution,
 * audio, duration, etc. in the unit count.
 *
 * `estimateFalCost` predicts a cost BEFORE a generation runs, for the
 * pre-flight credit gate. Preference order for the unit count (#1069):
 * our observed median (`MIN_OBSERVED_SAMPLES`+ generations), then fal's
 * historical estimate, then **null** ("unknown") — never a fabricated
 * default; a fixed one made Grok Imagine read ~98× cheap. Callers gate
 * conservatively / display nothing for null.
 */

// Type-only static import + dynamic import at the call site: a static value
// import would put `fal-pricing-live` (and through it `#db-client` /
// drizzle) in the client module graph — this module is reached from client
// components via `cost-estimation.ts` (#1253). Client callers always pass
// `pricingMap`, so the dynamic import only ever executes on the server.
import type { EffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import {
  type Microdollars,
  ZERO_MICROS,
  multiplyMicros,
} from '@/lib/billing/money';
import { getLogger } from '@/lib/observability/logger';

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
// Actual cost (billing) — unitsBilled × unitPrice
// ============================================================================

/**
 * Exact fal cost for a completed generation. Returns `ZERO_MICROS` (reported
 * via `reportMissingBillingCost`) when pricing is missing, unreadable, or fal
 * did not report `unitsBilled` — we charge nothing rather than guess.
 *
 * Never throws: it runs inside retried workflow steps after fal has billed,
 * and a rejection there discards a finished asset and pays fal again on the
 * retry. Tests pass `pricingMap` to skip D1.
 */
async function loadLivePricing(): Promise<Record<string, EffectiveFalPricing>> {
  const { getEffectiveFalPricing } = await import('@/lib/ai/fal-pricing-live');
  return getEffectiveFalPricing();
}

export async function falCostFromUnits(
  endpointId: string,
  unitsBilled: number | undefined,
  pricingMap?: Record<string, EffectiveFalPricing>
): Promise<Microdollars> {
  let pricing: EffectiveFalPricing | undefined;
  try {
    pricing = (pricingMap ?? (await loadLivePricing()))[endpointId];
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

// ============================================================================
// Pre-flight estimation — predicts a unit count from generation params
// ============================================================================

export type FalCostEstimateParams = {
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
 * `MIN_OBSERVED_SAMPLES` behind it), then fal's historical estimate.
 */
export function knownUnitsPerCall(
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
  return isUsableCount(pricing.typicalUnitsPerCall)
    ? pricing.typicalUnitsPerCall
    : undefined;
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

  const numImages = params.numImages ?? 1;
  const duration = params.durationSeconds ?? 0;

  switch (estimateStrategy(endpointId, pricing.unit)) {
    case 'per_call': {
      // Covers flat rates, per-image "units" prices (gpt-image-2 bills ~0.22
      // units per image on a $1 unit), and compute-seconds models (~10 to
      // ~294 s/image across models — unknowable from request params).
      const unitsPerCall = knownUnitsPerCall(pricing);
      if (unitsPerCall == null) {
        logger.error(
          `No unit-count signal for ${endpointId} (unit "${pricing.unit}") — ` +
            'estimate unknown (returns once a generation records unitsBilled)'
        );
        return null;
      }
      return multiplyMicros(pricing.unitPrice, unitsPerCall * numImages);
    }

    case 'megapixels': {
      const w = params.widthPx ?? 1024;
      const h = params.heightPx ?? 1024;
      const megapixels = (w * h) / 1_000_000;
      return multiplyMicros(pricing.unitPrice, megapixels * numImages);
    }

    case 'seconds':
      return multiplyMicros(pricing.unitPrice, duration);

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
