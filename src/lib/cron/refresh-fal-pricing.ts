/**
 * Daily fal pricing refresh (#1069).
 *
 * Driven by the Workers cron in `src/server.ts` (schedule in `wrangler.jsonc`
 * `triggers.crons`). Rebuilds the `model_pricing` D1 table — the platform's
 * only pricing record — from three signals:
 *
 * 1. fal's pricing API — per-unit price + raw unit for **every priced
 *    endpoint in fal's catalog** (~1,350), not just the models we expose.
 * 2. fal's historical estimate — typical units per call, fetched only for
 *    endpoints we use (the estimate API allows ~1 req/s). A failed fetch
 *    preserves the stored value rather than nulling it.
 * 3. `model_usage_observations` — median units per image from our own
 *    generations, the preferred estimation signal.
 *
 * Also appends `model_pricing_history` rows on price changes (and first
 * sight). Billing reads these prices, so a fal price move reaches real
 * charges on the next refresh — hence the warn log on every change.
 */

import { getDb } from '#db-client';
import { getEnv } from '#env';
import {
  getFalEndpointIds,
  UNLISTED_FAL_ENDPOINTS,
} from '@/lib/ai/fal-endpoints';
import { listCatalogEndpointIds } from '@/lib/models/catalog';
import {
  type FalUnitPrice,
  fetchFalBilledRates,
  fetchFalCatalogIds,
  fetchFalTypicalUnits,
  fetchFalUnitPrices,
} from '@/lib/ai/fal-pricing-fetch';
import {
  FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP,
  FAL_UNVERIFIED_SIBLINGS,
} from '@/lib/ai/fal-typical-units';
import { usdToMicros } from '@/lib/billing/money';
import {
  modelPricing,
  modelPricingHistory,
  modelUsageObservations,
  transactions,
} from '@/lib/db/schema';
import type { ObservedUnits } from '@/lib/db/schema/model-pricing';
import { getLogger } from '@/lib/observability/logger';
import { and, eq, lt, sql, type SQL } from 'drizzle-orm';
import type { drizzle as drizzleD1 } from 'drizzle-orm/d1';

const logger = getLogger(['openstory', 'cron', 'refresh-fal-pricing']);

/**
 * A db handle this job can write through: `getDb()` in Workerd, or drizzle
 * over the local Miniflare binding for `bun scripts/refresh-fal-pricing.ts`.
 */
export type PricingRefreshDb =
  | ReturnType<typeof getDb>
  | ReturnType<typeof drizzleD1>;

/**
 * Cron expression — must match `wrangler.jsonc` `triggers.crons` (default AND
 * production blocks); `scheduled()` in `src/server.ts` routes on it.
 */
export const FAL_PRICING_CRON = '17 3 * * *';

/** How far back observed unitsBilled samples count toward the median. */
const OBSERVATION_WINDOW_DAYS = 90;

/** Newest-first sample cap per endpoint, so a busy endpoint cannot crowd out a quiet one. */
export const OBSERVATIONS_PER_ENDPOINT = 200;

/**
 * D1 caps a query at 100 bound params. Snapshot upserts bind 10 columns per
 * row and history inserts 6 (defaulted columns bind too) — chunk both.
 */
export const UPSERT_CHUNK = 9;
export const HISTORY_CHUNK = 15;

/**
 * Fail the run when more than this share of used endpoints lost their
 * historical-estimate fetch — a broad failure (auth, outage) means nothing
 * fal said about history is trustworthy.
 */
const MAX_TYPICAL_FETCH_FAILURE_RATIO = 0.25;

export type FalPricingRefreshSummary = {
  /** Active models in fal's catalog. */
  catalogSize: number;
  /** Endpoints written to model_pricing (those with a price). */
  endpoints: number;
  priceChanges: number;
  observedEndpoints: number;
  observationSamples: number;
  prunedObservations: number;
};

/** Median of an unsorted list (mean of the middle pair for even lengths). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[mid - 1] ?? 0) + upper) / 2;
}

type ObservedUnitsByEndpoint = Map<string, ObservedUnits>;

/**
 * The single method `computeObservedUnits` needs — structural so tests can
 * run the query against plain libsql (the bug this guards lives in drizzle's
 * column mapping, so a stub would prove nothing).
 */
type ObservationReader = {
  all<T>(query: SQL): Promise<T[]>;
};

/**
 * The `model_pricing` composite key flattened for Map/Set lookup. `\u0000`
 * as an escape, never a literal NUL — that would make the file binary to git.
 */
function pricingKey(row: { endpointId: string; unit: string }): string {
  return `${row.endpointId}\u0000${row.unit}`;
}

function observationCutoff(): Date {
  return new Date(Date.now() - OBSERVATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * `createdAt` is `integer({ mode: 'timestamp' })` — stored in **seconds**.
 * Raw `sql` interpolation bypasses drizzle's Date mapping, so compare against
 * epoch seconds explicitly (the query-builder operators convert for you).
 */
function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Median observed units **per image** per fal endpoint. `unitsBilled` is per
 * call and a call can render several images, so samples divide by
 * `numImages` — the estimator multiplies back up. The newest-first cap is per
 * endpoint (window function), not global, so a high-volume model cannot
 * starve the rarely-used ones that most need a median (#1069).
 */
export async function computeObservedUnits(
  db: ObservationReader
): Promise<{ observed: ObservedUnitsByEndpoint; samples: number }> {
  const cutoff = observationCutoff();
  const rows = await db.all<{
    endpoint_id: string;
    units_billed: number;
    num_images: number;
  }>(sql`
    SELECT endpoint_id, units_billed, num_images FROM (
      SELECT
        ${modelUsageObservations.endpointId} AS endpoint_id,
        ${modelUsageObservations.unitsBilled} AS units_billed,
        ${modelUsageObservations.numImages} AS num_images,
        ROW_NUMBER() OVER (
          PARTITION BY ${modelUsageObservations.endpointId}
          ORDER BY ${modelUsageObservations.createdAt} DESC
        ) AS rn
      FROM ${modelUsageObservations}
      WHERE ${modelUsageObservations.provider} = 'fal'
        AND ${modelUsageObservations.createdAt} > ${toEpochSeconds(cutoff)}
    ) WHERE rn <= ${OBSERVATIONS_PER_ENDPOINT}
  `);

  const byEndpoint = new Map<string, number[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.units_billed) || row.units_billed <= 0) continue;
    const images =
      Number.isFinite(row.num_images) && row.num_images > 0
        ? row.num_images
        : 1;
    const perImage = row.units_billed / images;
    const list = byEndpoint.get(row.endpoint_id);
    if (list) list.push(perImage);
    else byEndpoint.set(row.endpoint_id, [perImage]);
  }

  const observed: ObservedUnitsByEndpoint = new Map();
  let samples = 0;
  for (const [endpointId, units] of byEndpoint) {
    observed.set(endpointId, {
      medianUnits: median(units),
      sampleCount: units.length,
    });
    samples += units.length;
  }
  return { observed, samples };
}

/**
 * Median unitsBilled from credit transactions, for endpoints whose
 * observations table is empty. Same window as `computeObservedUnits`.
 * Skips samples that already have an observation so we do not double-count.
 */
export async function computeLedgerObservedUnits(
  db: ObservationReader
): Promise<{ observed: ObservedUnitsByEndpoint; samples: number }> {
  const cutoff = observationCutoff();
  const rows = await db.all<{
    endpoint_id: string;
    units_billed: number;
    num_images: number;
  }>(sql`
    SELECT endpoint_id, units_billed, num_images FROM (
      SELECT
        json_extract(${transactions.metadata}, '$.endpointId') AS endpoint_id,
        json_extract(${transactions.metadata}, '$.unitsBilled') AS units_billed,
        COALESCE(json_extract(${transactions.metadata}, '$.numImages'), 1)
          AS num_images,
        ROW_NUMBER() OVER (
          PARTITION BY json_extract(${transactions.metadata}, '$.endpointId')
          ORDER BY ${transactions.createdAt} DESC
        ) AS rn
      FROM ${transactions}
      WHERE ${transactions.type} = 'credit_usage'
        AND ${transactions.createdAt} > ${toEpochSeconds(cutoff)}
        AND json_extract(${transactions.metadata}, '$.unitsBilled') IS NOT NULL
        AND json_extract(${transactions.metadata}, '$.endpointId') IS NOT NULL
        AND (
          json_extract(${transactions.metadata}, '$.billingProvider') IS NULL
          OR json_extract(${transactions.metadata}, '$.billingProvider') = 'fal'
        )
    ) WHERE rn <= ${OBSERVATIONS_PER_ENDPOINT}
  `);

  const byEndpoint = new Map<string, number[]>();
  for (const row of rows) {
    if (typeof row.endpoint_id !== 'string' || row.endpoint_id.length === 0) {
      continue;
    }
    if (!Number.isFinite(row.units_billed) || row.units_billed <= 0) continue;
    const images =
      Number.isFinite(row.num_images) && row.num_images > 0
        ? row.num_images
        : 1;
    const perImage = row.units_billed / images;
    const list = byEndpoint.get(row.endpoint_id);
    if (list) list.push(perImage);
    else byEndpoint.set(row.endpoint_id, [perImage]);
  }

  const observed: ObservedUnitsByEndpoint = new Map();
  let samples = 0;
  for (const [endpointId, units] of byEndpoint) {
    observed.set(endpointId, {
      medianUnits: median(units),
      sampleCount: units.length,
    });
    samples += units.length;
  }
  return { observed, samples };
}

/**
 * Observed median: our usage samples first, then transaction metadata for
 * endpoints that somehow missed an observation write (#1382).
 */
export async function collectObservedUnits(
  db: ObservationReader
): Promise<{ observed: ObservedUnitsByEndpoint; samples: number }> {
  const fromObs = await computeObservedUnits(db);
  const fromLedger = await computeLedgerObservedUnits(db);
  for (const [endpointId, ledger] of fromLedger.observed) {
    if (fromObs.observed.has(endpointId)) continue;
    fromObs.observed.set(endpointId, ledger);
    fromObs.samples += ledger.sampleCount;
  }
  return fromObs;
}

/**
 * Patch `observed_median_units` (and a missing H3 Max typical) onto existing
 * `model_pricing` rows. Used by the hourly reconcile so a day's samples do
 * not wait until 03:17 UTC to feed the estimator.
 */
export async function writeObservedUnits(
  db: PricingRefreshDb,
  now: Date = new Date()
): Promise<number> {
  const { observed } = await collectObservedUnits(db);
  const rows = await db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.provider, 'fal'));
  const rowsByEndpoint = new Map(rows.map((r) => [r.endpointId, r]));

  let written = 0;
  for (const [endpointId, obs] of observed) {
    const row = rowsByEndpoint.get(endpointId);
    if (!row) continue;
    const fallbackTypical =
      FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP[endpointId] ?? null;
    await db
      .update(modelPricing)
      .set({
        observedMedianUnits: obs.medianUnits,
        observedSampleCount: obs.sampleCount,
        ...(row.typicalUnitsPerCall == null && fallbackTypical != null
          ? { typicalUnitsPerCall: fallbackTypical }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(modelPricing.provider, 'fal'),
          eq(modelPricing.endpointId, endpointId),
          eq(modelPricing.unit, row.unit)
        )
      );
    written++;
  }

  for (const [endpointId, typical] of Object.entries(
    FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP
  )) {
    const row = rowsByEndpoint.get(endpointId);
    if (!row || row.typicalUnitsPerCall != null) continue;
    if (observed.has(endpointId)) continue;
    await db
      .update(modelPricing)
      .set({ typicalUnitsPerCall: typical, updatedAt: now })
      .where(
        and(
          eq(modelPricing.provider, 'fal'),
          eq(modelPricing.endpointId, endpointId),
          eq(modelPricing.unit, row.unit)
        )
      );
  }
  return written;
}

/**
 * Copy a bill-verified rate onto a sibling with no usage of its own
 * (H3 Max t2v ← i2v, #1382). Stamps the target as verified so the advertised
 * "compute seconds" lie cannot overwrite it on the next advertised fetch.
 */
function overlaySiblingBilledRates(
  prices: FalUnitPrice[],
  verifiedNow: Set<string>,
  verifiedExisting: ReadonlySet<string> = new Set()
): void {
  const priceByEndpoint = new Map(prices.map((p) => [p.endpointId, p]));
  for (const [target, source] of Object.entries(FAL_UNVERIFIED_SIBLINGS)) {
    if (verifiedNow.has(target)) continue;
    if (!verifiedNow.has(source) && !verifiedExisting.has(source)) continue;
    const sourcePrice = priceByEndpoint.get(source);
    if (!sourcePrice) continue;
    const targetPrice = priceByEndpoint.get(target);
    if (targetPrice) {
      if (
        targetPrice.unit !== sourcePrice.unit ||
        targetPrice.unitPriceUsd !== sourcePrice.unitPriceUsd
      ) {
        logger.warn(
          'unverified sibling inheriting billed rate from source endpoint',
          {
            target,
            source,
            from: {
              unit: targetPrice.unit,
              unitPriceUsd: targetPrice.unitPriceUsd,
            },
            to: {
              unit: sourcePrice.unit,
              unitPriceUsd: sourcePrice.unitPriceUsd,
            },
          }
        );
      }
      targetPrice.unit = sourcePrice.unit;
      targetPrice.unitPriceUsd = sourcePrice.unitPriceUsd;
    } else {
      prices.push({
        endpointId: target,
        unit: sourcePrice.unit,
        unitPriceUsd: sourcePrice.unitPriceUsd,
      });
    }
    verifiedNow.add(target);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Drop observations for any endpoint fal re-denominated since the last
 * refresh: samples taken under the old unit (e.g. compute-seconds, ~294/call)
 * are not comparable to the new one (images, ~1/call), and a median over the
 * mixed bag is a confident number that is orders of magnitude wrong — #1069
 * through the mechanism meant to prevent it. The median rebuilds within
 * `MIN_OBSERVED_SAMPLES` generations.
 */
async function discardObservationsForRedenominatedEndpoints(
  db: PricingRefreshDb,
  existing: { endpointId: string; unit: string }[],
  unitPrices: FalUnitPrice[]
): Promise<void> {
  const previousUnit = new Map(existing.map((r) => [r.endpointId, r.unit]));
  for (const price of unitPrices) {
    const before = previousUnit.get(price.endpointId);
    if (before == null || before === price.unit) continue;
    await db
      .delete(modelUsageObservations)
      .where(
        and(
          eq(modelUsageObservations.provider, 'fal'),
          eq(modelUsageObservations.endpointId, price.endpointId)
        )
      );
    logger.warn(
      'fal re-denominated an endpoint — discarding its observations so the median cannot mix units',
      { endpointId: price.endpointId, fromUnit: before, toUnit: price.unit }
    );
  }
}

/**
 * Fetch fal pricing + our observed units and write snapshot + history.
 *
 * `deps` exists for `bun scripts/refresh-fal-pricing.ts`: outside Workerd
 * `getDb()` throws by design and `#env` has no Worker bindings.
 */
export async function refreshFalPricing(
  deps: {
    db?: PricingRefreshDb;
    apiKey?: string;
    billingKey?: string;
  } = {}
): Promise<FalPricingRefreshSummary> {
  const apiKey = deps.apiKey ?? getEnv().FAL_KEY;
  if (!apiKey) {
    throw new Error('refreshFalPricing: FAL_KEY is not configured');
  }
  // Admin-scoped key for the usage API. Optional and not in the generated
  // worker env types — same narrowing as MODELSCHEMAS_API_KEY.
  const billingKey =
    deps.billingKey ??
    (getEnv() as ReturnType<typeof getEnv> & { FAL_BILLING_KEY?: string })
      .FAL_BILLING_KEY;

  const db = deps.db ?? getDb();
  const catalogIds = await fetchFalCatalogIds(apiKey);
  const usedEndpoints = getFalEndpointIds();

  // The Models feature runs any endpoint the modelschemas catalog lists, and
  // that set is not a subset of fal's active listing — so union both, plus
  // our configured endpoints and the known unlisted ones (seedance
  // enterprise), none of which appear in either listing. A modelschemas
  // outage degrades coverage, not the refresh.
  let modelsCatalogIds: string[] = [];
  try {
    modelsCatalogIds = await listCatalogEndpointIds();
  } catch (err) {
    logger.warn('modelschemas catalog unreachable — refreshing without it', {
      err,
    });
  }
  const requestedIds = [
    ...new Set([
      ...catalogIds,
      ...modelsCatalogIds,
      ...UNLISTED_FAL_ENDPOINTS,
      ...usedEndpoints,
    ]),
  ];

  const { prices, failedEndpoints: priceFetchFailures } =
    await fetchFalUnitPrices(apiKey, requestedIds);
  // The stale sweep below deletes every row absent from this list, so an
  // empty result would silently wipe model_pricing. Refuse before writing.
  if (prices.length === 0) {
    throw new Error(
      `refreshFalPricing: fal returned no prices for ${requestedIds.length} requested ` +
        'endpoints — aborting before the stale sweep would empty model_pricing'
    );
  }

  const existing = await db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.provider, 'fal'));

  // Overlay the usage API's billed rates: the pricing API can disagree with
  // what fal actually bills (Grok Imagine: "compute seconds" × $0.00017
  // reported vs "units" × $0.01 billed — a ~59× under-charge), and the bill
  // is the only source that cannot. Runs BEFORE the typical-units fetch so
  // its cost→units conversion divides by the real price.
  const verifiedNow = new Set<string>();
  if (billingKey) {
    const billedRates = await fetchFalBilledRates(billingKey);
    const priceByEndpoint = new Map(prices.map((p) => [p.endpointId, p]));
    for (const rate of billedRates) {
      verifiedNow.add(rate.endpointId);
      const fetched = priceByEndpoint.get(rate.endpointId);
      if (
        fetched &&
        fetched.unit === rate.unit &&
        fetched.unitPriceUsd === rate.unitPriceUsd
      ) {
        continue;
      }
      if (fetched) {
        logger.warn(
          'fal pricing API disagrees with billed usage — using the bill',
          {
            endpointId: rate.endpointId,
            reported: {
              unit: fetched.unit,
              unitPriceUsd: fetched.unitPriceUsd,
            },
            billed: { unit: rate.unit, unitPriceUsd: rate.unitPriceUsd },
          }
        );
        fetched.unit = rate.unit;
        fetched.unitPriceUsd = rate.unitPriceUsd;
      } else {
        // Billed but unpriced (aliases, delisted models) — the bill proves it
        // exists and what it costs.
        prices.push({
          endpointId: rate.endpointId,
          unit: rate.unit,
          unitPriceUsd: rate.unitPriceUsd,
        });
      }
    }
  } else {
    // Without the bill to check against, a pricing-API mispricing goes
    // straight into charges — say so every night until the secret exists.
    logger.error(
      'FAL_BILLING_KEY is not configured — cannot verify prices against billed usage'
    );
  }

  // Once the bill has confirmed a rate, the advertised rate can never
  // overwrite it — only newer billed data (this run's overlay, or the hourly
  // reconcile) can. Endpoints whose usage aged out of the overlay window
  // would otherwise revert to a rate already proven wrong.
  const verifiedExisting = new Map<string, (typeof existing)[number]>();
  for (const row of existing) {
    if (row.rateVerifiedAt == null) continue;
    const prev = verifiedExisting.get(row.endpointId);
    if (
      !prev ||
      row.rateVerifiedAt.getTime() > (prev.rateVerifiedAt?.getTime() ?? 0)
    ) {
      verifiedExisting.set(row.endpointId, row);
    }
  }
  for (const p of prices) {
    if (verifiedNow.has(p.endpointId)) continue;
    const verified = verifiedExisting.get(p.endpointId);
    if (!verified) continue;
    p.unit = verified.unit;
    p.unitPriceUsd = verified.unitPriceMicros / 1_000_000;
  }

  // Sibling copy after verified-existing preservation so t2v inherits i2v's
  // bill-verified rate even when i2v's usage aged out of this run's overlay.
  overlaySiblingBilledRates(
    prices,
    verifiedNow,
    new Set(verifiedExisting.keys())
  );

  // A used endpoint without a price would bill $0 after the sweep dropped its
  // row. Abort the whole run so yesterday's snapshot survives.
  const pricedIds = new Set(prices.map((p) => p.endpointId));
  const missingUsed = usedEndpoints.filter((id) => !pricedIds.has(id));
  if (missingUsed.length > 0) {
    throw new Error(
      `refreshFalPricing: fal returned no price for used endpoint(s): ${missingUsed.join(', ')}`
    );
  }

  // Historical estimates only for endpoints we use — the estimate API allows
  // ~1 req/s, so the full catalog would take ~25 minutes per run.
  const usedSet = new Set(usedEndpoints);
  const usedPrices = prices.filter((p) => usedSet.has(p.endpointId));
  const { typicalUnits, failedEndpoints } = await fetchFalTypicalUnits(
    apiKey,
    usedPrices
  );

  // A broad historical-fetch failure is no reason to discard the live unit
  // prices (which drive every real charge) or the observed medians (which
  // don't depend on fal at all). Preserve stored typicals, write the rest,
  // throw at the end so the cron still reads as failed.
  const typicalDegraded =
    failedEndpoints.size / usedPrices.length > MAX_TYPICAL_FETCH_FAILURE_RATIO;

  const existingPriceByKey = new Map(
    existing.map((row) => [pricingKey(row), row.unitPriceMicros])
  );
  const existingTypicalByKey = new Map(
    existing.map((row) => [pricingKey(row), row.typicalUnitsPerCall])
  );

  await discardObservationsForRedenominatedEndpoints(db, existing, prices);
  const { observed, samples } = await collectObservedUnits(db);

  const now = new Date();
  const snapshotRows = prices.map((p) => {
    const obs = observed.get(p.endpointId);
    const key = pricingKey(p);
    // A failed typical fetch carries the stored value forward — absence of an
    // answer is not an answer of "none". A genuine no-history reply uses the
    // billed-units fallback (H3 Max 8/5s) when we have one, else nulls.
    const fallbackTypical =
      FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP[p.endpointId] ?? null;
    const typical =
      typicalUnits.get(p.endpointId) ??
      (typicalDegraded || failedEndpoints.has(p.endpointId)
        ? (existingTypicalByKey.get(key) ?? fallbackTypical)
        : fallbackTypical);
    return {
      provider: 'fal' as const,
      endpointId: p.endpointId,
      unit: p.unit,
      unitPriceMicros: usdToMicros(p.unitPriceUsd),
      rateVerifiedAt: verifiedNow.has(p.endpointId)
        ? now
        : (verifiedExisting.get(p.endpointId)?.rateVerifiedAt ?? null),
      typicalUnitsPerCall: typical,
      observedMedianUnits: obs?.medianUnits ?? null,
      observedSampleCount: obs?.sampleCount ?? 0,
      fetchedAt: now,
      updatedAt: now,
    };
  });

  // History: append on first sight or when the unit price moved.
  const historyRows = snapshotRows
    .filter(
      (row) => existingPriceByKey.get(pricingKey(row)) !== row.unitPriceMicros
    )
    .map((row) => ({
      provider: row.provider,
      endpointId: row.endpointId,
      unit: row.unit,
      unitPriceMicros: row.unitPriceMicros,
      recordedAt: now,
    }));

  for (const rows of chunk(historyRows, HISTORY_CHUNK)) {
    await db.insert(modelPricingHistory).values(rows);
  }

  // A price move changes what teams are charged for endpoints we expose —
  // say so loudly rather than only appending a history row nobody reads.
  for (const row of historyRows) {
    const previous = existingPriceByKey.get(pricingKey(row));
    if (previous == null || !usedSet.has(row.endpointId)) continue;
    logger.warn('fal unit price changed — charges move with it', {
      endpointId: row.endpointId,
      unit: row.unit,
      fromMicros: previous,
      toMicros: row.unitPriceMicros,
    });
  }

  for (const rows of chunk(snapshotRows, UPSERT_CHUNK)) {
    await db
      .insert(modelPricing)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          modelPricing.provider,
          modelPricing.endpointId,
          modelPricing.unit,
        ],
        set: {
          unitPriceMicros: sql`excluded.unit_price_micros`,
          rateVerifiedAt: sql`excluded.rate_verified_at`,
          typicalUnitsPerCall: sql`excluded.typical_units_per_call`,
          observedMedianUnits: sql`excluded.observed_median_units`,
          observedSampleCount: sql`excluded.observed_sample_count`,
          fetchedAt: sql`excluded.fetched_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  // Sweep rows fal no longer prices (retired endpoints, re-denominated units)
  // — but never ones whose price fetch merely errored this run.
  const freshKeys = new Set(snapshotRows.map((row) => pricingKey(row)));
  const fetchFailed = new Set(priceFetchFailures);
  const staleRows = existing.filter(
    (row) => !freshKeys.has(pricingKey(row)) && !fetchFailed.has(row.endpointId)
  );
  for (const row of staleRows) {
    await db
      .delete(modelPricing)
      .where(
        and(
          eq(modelPricing.provider, 'fal'),
          eq(modelPricing.endpointId, row.endpointId),
          eq(modelPricing.unit, row.unit)
        )
      );
  }

  // Samples past the window can never feed a median again. Counted with a
  // SELECT rather than `.returning()`, which would materialise every pruned
  // id in the isolate.
  const pruneCutoff = observationCutoff();
  const [pruneCount] = await db.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${modelUsageObservations}
        WHERE ${modelUsageObservations.createdAt} < ${toEpochSeconds(pruneCutoff)}`
  );
  await db
    .delete(modelUsageObservations)
    .where(lt(modelUsageObservations.createdAt, pruneCutoff));

  const summary: FalPricingRefreshSummary = {
    catalogSize: catalogIds.length,
    endpoints: snapshotRows.length,
    priceChanges: historyRows.length,
    observedEndpoints: observed.size,
    observationSamples: samples,
    prunedObservations: pruneCount?.n ?? 0,
  };
  logger.info('fal pricing refresh complete', { ...summary });

  // Thrown after the write: an estimate-API outage costs only the typical
  // refresh — prices and medians still landed, and the operator still sees a
  // failed cron rather than a silent degradation.
  if (typicalDegraded) {
    throw new Error(
      `refreshFalPricing: ${failedEndpoints.size}/${usedPrices.length} historical ` +
        'estimate fetches failed — prices and observed medians were written and ' +
        'stored typicalUnitsPerCall values preserved'
    );
  }
  return summary;
}
