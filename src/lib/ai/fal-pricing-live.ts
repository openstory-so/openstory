/**
 * Live fal pricing from the `model_pricing` D1 table — the only pricing
 * record (#1069). The daily Worker cron fills it with every priced endpoint
 * in fal's catalog; locally, run `bun scripts/refresh-fal-pricing.ts`.
 * Both estimation and billing read it, so a fal price move reaches real
 * charges on the next refresh. Cached per isolate for a few minutes.
 */

import { getDb } from '#db-client';
import { isBytePlusConfigured } from '@/lib/ai/byteplus-config';
import { BYTEPLUS_RATE_CARD } from '@/lib/ai/byteplus-pricing';
import {
  FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP,
  FAL_UNVERIFIED_SIBLINGS,
} from '@/lib/ai/fal-typical-units';
import {
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  MOTION_REFERENCE_ENDPOINTS,
} from '@/lib/ai/models';
import { typedEntries } from '@/lib/utils/typed-object';
import { micros, type Microdollars } from '@/lib/billing/money';
import { modelPricing } from '@/lib/db/schema';
import type { ObservedUnits } from '@/lib/db/schema/model-pricing';
import { getLogger } from '@/lib/observability/logger';
import { eq } from 'drizzle-orm';

const logger = getLogger(['openstory', 'ai', 'fal-pricing-live']);

/** One endpoint's pricing row, as estimation and billing consume it. */
export type EffectiveFalPricing = {
  /** Per-unit price in microdollars, verbatim from fal. */
  unitPrice: Microdollars;
  /** Raw fal unit string (e.g. "images", "compute seconds", "units"). */
  unit: string;
  /** Fal's historical estimate of units per call. */
  typicalUnitsPerCall?: number;
  /**
   * Median unitsBilled per image across our own recent generations, with its
   * sample count. The preferred estimation signal — readers apply
   * `MIN_OBSERVED_SAMPLES` before trusting the median.
   */
  observed?: ObservedUnits;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Past two missed daily runs the cron is failing silently — and a stale table
 * produces the same-looking estimates as a fresh one, so this log is the only
 * thing that can tell them apart.
 */
const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

type PricingRow = typeof modelPricing.$inferSelect;

let cache: {
  at: number;
  map: Record<string, EffectiveFalPricing>;
  updatedAt: Date | null;
} | null = null;

/** Build the endpoint→pricing map from `model_pricing` rows. */
export function buildFalPricingMap(
  rows: PricingRow[]
): Record<string, EffectiveFalPricing> {
  const map: Record<string, EffectiveFalPricing> = {};
  const duplicates = new Set<string>();
  for (const row of rows) {
    // The table key is (provider, endpointId, unit), so an endpoint fal
    // re-denominated can briefly have two rows. Billing multiplies unitsBilled
    // by this price, so an arbitrary winner is a wrong charge — drop the
    // endpoint and let it be a visible unknown until the cron's sweep runs.
    if (map[row.endpointId]) {
      duplicates.add(row.endpointId);
      continue;
    }
    map[row.endpointId] = {
      unitPrice: micros(row.unitPriceMicros),
      unit: row.unit,
      typicalUnitsPerCall:
        row.typicalUnitsPerCall ??
        FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP[row.endpointId],
      // The DB CHECK keeps median and count consistent.
      ...(row.observedMedianUnits != null && {
        observed: {
          medianUnits: row.observedMedianUnits,
          sampleCount: row.observedSampleCount,
        } satisfies ObservedUnits,
      }),
    };
  }
  for (const endpointId of duplicates) {
    logger.error(
      'model_pricing has multiple rows for one endpoint — dropping it rather than billing an arbitrary rate',
      { endpointId }
    );
    delete map[endpointId];
  }
  return map;
}

async function load(): Promise<NonNullable<typeof cache>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;

  const rows = await getDb()
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.provider, 'fal'));

  warnIfStale(rows);
  const updatedAt = rows.length
    ? new Date(Math.max(...rows.map((r) => r.fetchedAt.getTime())))
    : null;
  // BytePlus rates are a static card, not cron-refreshed rows (#1157) — see
  // byteplus-pricing.ts. Merged first so a `model_pricing` row for the same id
  // (if the cron ever learns Ark) wins over the hand-maintained rate.
  const map = { ...BYTEPLUS_RATE_CARD, ...buildFalPricingMap(rows) };
  applyBytePlusRouteAliases(map);
  applyUnverifiedSiblingRates(map);
  cache = { at: Date.now(), map, updatedAt };
  return cache;
}

/**
 * Point a repointed model's FAL endpoint id at its BytePlus rate (#1157).
 *
 * The route is a server fact, and this map is the one thing every consumer
 * already reads — estimators, credit gates, the /pricing page, and the
 * client's ActionCost payload. Aliasing here means none of them needs to know
 * the route: looking up the fal id a catalog entry still carries yields the
 * rate the generation will actually be billed at.
 *
 * The BytePlus id keeps its own entry, so the exact post-generation charge
 * (which looks the id up directly) is unaffected either way.
 */
function applyBytePlusRouteAliases(
  map: Record<string, EffectiveFalPricing>
): void {
  if (!isBytePlusConfigured()) return;

  for (const model of Object.values(IMAGE_MODELS)) {
    if (!('byteplusId' in model)) continue;
    const rate = map[model.byteplusId];
    if (rate) map[model.id] = rate;
  }

  for (const [modelKey, model] of typedEntries(IMAGE_TO_VIDEO_MODELS)) {
    if (!('byteplusId' in model)) continue;
    const rate = map[model.byteplusId];
    if (!rate) continue;
    map[model.id] = rate;
    // Seedance with cast/element refs bills on a SEPARATE fal endpoint; on Ark
    // it is the same model id, so that endpoint aliases too — otherwise a
    // referenced shot silently quotes the fal rate.
    const referenceEndpoint = MOTION_REFERENCE_ENDPOINTS[modelKey];
    if (referenceEndpoint) map[referenceEndpoint.endpointId] = rate;
  }
}

/**
 * Point an unused sibling at the bill-verified source rate (#1382).
 * MiniMax H3 Max t2v has the same advertised rates as i2v but no usage, so
 * fal's pricing API still reports "compute seconds × $0.00017". Looking up
 * the t2v id must yield the i2v billed rate or studio estimates are ~150× low.
 */
function applyUnverifiedSiblingRates(
  map: Record<string, EffectiveFalPricing>
): void {
  for (const [target, source] of Object.entries(FAL_UNVERIFIED_SIBLINGS)) {
    const sourceRate = map[source];
    if (!sourceRate) continue;
    const targetRate = map[target];
    map[target] = {
      unitPrice: sourceRate.unitPrice,
      unit: sourceRate.unit,
      typicalUnitsPerCall:
        targetRate?.typicalUnitsPerCall ??
        sourceRate.typicalUnitsPerCall ??
        FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP[target],
      ...((targetRate?.observed ?? sourceRate.observed)
        ? { observed: targetRate?.observed ?? sourceRate.observed }
        : {}),
    };
  }
}

export async function getEffectiveFalPricing(): Promise<
  Record<string, EffectiveFalPricing>
> {
  return (await load()).map;
}

/** When the pricing snapshot was last refreshed (null = never). */
export async function getFalPricingUpdatedAt(): Promise<Date | null> {
  return (await load()).updatedAt;
}

function warnIfStale(rows: { fetchedAt: Date; endpointId: string }[]): void {
  if (rows.length === 0) {
    // Local dev / e2e / a fresh deploy before the first refresh. Estimates
    // gate on the unknown floor and billing records $0 charges until a
    // refresh lands.
    logger.warn(
      'model_pricing is empty — no fal pricing available until a refresh runs'
    );
    return;
  }
  // The OLDEST row: a successful refresh stamps every row with one `now`, and
  // the writes are chunked — keying off the newest would hide a nightly
  // partial failure forever.
  const cutoff = Date.now() - STALE_AFTER_MS;
  const staleRows = rows.filter((row) => row.fetchedAt.getTime() < cutoff);
  if (staleRows.length === 0) return;
  const oldest = Math.min(...staleRows.map((row) => row.fetchedAt.getTime()));
  logger.error(
    'model_pricing is stale — the daily refresh cron has not run successfully',
    {
      staleRows: staleRows.length,
      totalRows: rows.length,
      partial: staleRows.length < rows.length,
      ageHours: Math.round((Date.now() - oldest) / 3_600_000),
      oldestFetchedAt: new Date(oldest).toISOString(),
      endpoints: staleRows.slice(0, 10).map((row) => row.endpointId),
    }
  );
}
