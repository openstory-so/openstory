/**
 * Guards for the daily pricing refresh (#1069).
 *
 * Classes of failure that production would not surface:
 *
 * 1. Cron wiring. `scheduled()` routes on an exact string match against
 *    `FAL_PRICING_CRON` and returns early. If `wrangler.jsonc` drifts, the
 *    refresh never runs AND the drifted expression falls through to the
 *    stuck-job reconcile sweep — which succeeds, so nothing fails. Pricing
 *    just quietly freezes. (Same three-places problem the workflow wiring
 *    test exists for.)
 *
 * 2. D1's 100-bound-param ceiling. Unit tests run on libsql, which has no
 *    such cap, so an over-wide chunk passes CI and throws only in production
 *    (the #1019 class of bug). Assert the arithmetic directly against the
 *    real column counts instead of trusting a comment.
 *
 * 3. The observed-median query returning nothing. Every failure mode here is
 *    silent — an empty result is indistinguishable from "no generations yet",
 *    so the refresh logs success while the feature is inert. The first cut
 *    compared the seconds-denominated `createdAt` against a millisecond
 *    cutoff and could never match a row.
 *
 * 4. Orchestration. Every failure mode in `refreshFalPricing` either writes a
 *    plausible snapshot or deletes a good one, and then logs success — an
 *    empty fetch result wipes the table via the stale sweep, and a fal outage
 *    used to discard live prices and our own medians along with it.
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  collectObservedUnits,
  computeLedgerObservedUnits,
  computeObservedUnits,
  FAL_PRICING_CRON,
  HISTORY_CHUNK,
  OBSERVATIONS_PER_ENDPOINT,
  UPSERT_CHUNK,
} from '@/lib/cron/refresh-fal-pricing';
import {
  modelPricing,
  modelPricingHistory,
  teams,
  transactions,
} from '@/lib/db/schema';
import { modelUsageObservations } from '@/lib/db/schema/model-pricing';
import { eq, getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

const WRANGLER_PATH = 'wrangler.jsonc';

/** D1 rejects a query binding more than this many params. */
const D1_MAX_BOUND_PARAMS = 100;

describe('fal pricing cron wiring', () => {
  const wrangler = readFileSync(WRANGLER_PATH, 'utf-8');

  test('the cron expression is registered in the default block', () => {
    // The default block drives `bun dev` and is the patch base for PR previews.
    const defaultCrons = wrangler.slice(0, wrangler.indexOf('"env"'));
    expect(defaultCrons).toContain(FAL_PRICING_CRON);
  });

  test('the cron expression is registered in [env.production]', () => {
    // Production builds bake this block; a missing entry means the job never
    // runs in prod no matter what the code says.
    const productionBlock = wrangler.slice(wrangler.indexOf('"production"'));
    expect(productionBlock).toContain(FAL_PRICING_CRON);
  });

  test('the reconcile sweep still has its own schedule', () => {
    // `scheduled()` in src/server.ts returns early on its match; the 5-minute
    // sweep must remain the fall-through case.
    expect(wrangler).toContain('*/5 * * * *');
    expect(FAL_PRICING_CRON).not.toBe('*/5 * * * *');
  });
});

describe('D1 bound-param ceiling', () => {
  test('model_pricing upserts stay under the cap', () => {
    const columns = Object.keys(getTableColumns(modelPricing)).length;
    expect(columns * UPSERT_CHUNK).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });

  test('model_pricing_history inserts stay under the cap', () => {
    // `id` binds too — it comes from $defaultFn, not a SQL default (#1019).
    const columns = Object.keys(getTableColumns(modelPricingHistory)).length;
    expect(columns * HISTORY_CHUNK).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
  });
});

describe('computeObservedUnits', () => {
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client });

  beforeEach(async () => {
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    await db.delete(modelUsageObservations);
  });

  test('sees observations written now (cutoff units must match the column)', async () => {
    await db.insert(modelUsageObservations).values({
      provider: 'fal',
      endpointId: 'xai/grok-imagine',
      unitsBilled: 294,
      numImages: 1,
    });

    const { observed, samples } = await computeObservedUnits(db);

    // `createdAt` is stored in seconds; comparing it against a millisecond
    // cutoff matched zero rows and pinned every model to the $0.10 floor.
    expect(samples).toBe(1);
    expect(observed.get('xai/grok-imagine')).toEqual({
      medianUnits: 294,
      sampleCount: 1,
    });
  });

  test('divides unitsBilled by numImages so the median is per image', async () => {
    // The estimator multiplies its per-image count back up by numImages, so a
    // 4-image call must not contribute a 4x sample.
    await db.insert(modelUsageObservations).values([
      {
        provider: 'fal',
        endpointId: 'fal-ai/flux-2',
        unitsBilled: 8,
        numImages: 4,
      },
      {
        provider: 'fal',
        endpointId: 'fal-ai/flux-2',
        unitsBilled: 4,
        numImages: 4,
      },
    ]);

    const { observed } = await computeObservedUnits(db);

    expect(observed.get('fal-ai/flux-2')).toEqual({
      medianUnits: 1.5,
      sampleCount: 2,
    });
  });

  test('ignores samples older than the observation window', async () => {
    await db.insert(modelUsageObservations).values({
      provider: 'fal',
      endpointId: 'fal-ai/flux-2',
      unitsBilled: 99,
      numImages: 1,
      createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
    });

    const { observed, samples } = await computeObservedUnits(db);

    expect(samples).toBe(0);
    expect(observed.size).toBe(0);
  });

  test('caps newest-first PER ENDPOINT, so a busy model cannot starve a quiet one', async () => {
    // Pins all three properties of the window function at once. A plain global
    // `LIMIT 200` drops `quiet` entirely (its rows are the oldest here), which
    // is the starvation the per-endpoint partition exists to prevent — and it
    // would starve exactly the rarely-used compute-seconds endpoints that most
    // need an observed median (#1069). Flipping ORDER BY to ASC moves `busy`'s
    // median from 2 to 451.
    const base = Date.now();
    const busy = Array.from({ length: 250 }, (_, i) => ({
      provider: 'fal' as const,
      endpointId: 'fal-ai/busy',
      // Newest 150 bill 2 units; the older 100 bill 900. Under the correct
      // newest-first cap the 900s fall outside the window entirely.
      unitsBilled: i < 150 ? 2 : 900,
      numImages: 1,
      createdAt: new Date(base - i * 1000),
    }));
    const quiet = Array.from({ length: 3 }, (_, i) => ({
      provider: 'fal' as const,
      endpointId: 'fal-ai/quiet',
      unitsBilled: 42,
      numImages: 1,
      createdAt: new Date(base - 500_000 - i * 1000),
    }));
    for (let i = 0; i < busy.length; i += 50) {
      await db.insert(modelUsageObservations).values(busy.slice(i, i + 50));
    }
    await db.insert(modelUsageObservations).values(quiet);

    const { observed } = await computeObservedUnits(db);

    expect(observed.get('fal-ai/busy')).toEqual({
      medianUnits: 2,
      sampleCount: OBSERVATIONS_PER_ENDPOINT,
    });
    expect(observed.get('fal-ai/quiet')).toEqual({
      medianUnits: 42,
      sampleCount: 3,
    });
  });

  test('ignores another provider’s observations', async () => {
    // The map is keyed by endpointId alone, so an OpenRouter row sharing an id
    // would silently pollute a fal median.
    await db.insert(modelUsageObservations).values({
      provider: 'openrouter',
      endpointId: 'fal-ai/flux-2',
      unitsBilled: 5000,
      numImages: 1,
    });

    const { observed, samples } = await computeObservedUnits(db);

    expect(samples).toBe(0);
    expect(observed.size).toBe(0);
  });
});

/**
 * Orchestration. Every failure below writes a plausible snapshot and logs
 * success, so none of it is observable in production — the refresh either
 * silently degrades what it already had, or (in the empty case) deletes it.
 */
describe('refreshFalPricing', () => {
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client });

  /** Args the stubbed typical-units fetch was called with, per load(). */
  let typicalCalledWith: { endpointId: string }[] | undefined;
  /** Ids the stubbed price fetch was asked about, per load(). */
  let pricesRequested: string[] | undefined;

  /** Load the module with fal's fetchers stubbed and D1 pointed at libsql. */
  async function load(opts: {
    prices: { endpointId: string; unitPriceUsd: number; unit: string }[];
    typical?: Record<string, number>;
    failed?: string[];
    /** Endpoints our model configs use; defaults to every priced endpoint. */
    used?: string[];
    /** The full catalog listing; defaults to every priced endpoint. */
    catalog?: string[];
    /** modelschemas catalog ids (the Models feature's universe). */
    modelsCatalog?: string[];
    /** Endpoints whose price fetch errored. */
    priceFailures?: string[];
    /** Usage-API billed rates (the overlay source). */
    billed?: {
      endpointId: string;
      unit: string;
      unitPriceUsd: number;
      costUsd: number;
    }[];
  }) {
    vi.resetModules();
    typicalCalledWith = undefined;
    pricesRequested = undefined;
    vi.doMock('#db-client', () => ({ getDb: () => db }));
    vi.doMock('#env', () => ({ getEnv: () => ({ FAL_KEY: 'test-key' }) }));
    vi.doMock('@/lib/models/catalog', () => ({
      listCatalogEndpointIds: () => Promise.resolve(opts.modelsCatalog ?? []),
    }));
    vi.doMock('@/lib/ai/fal-endpoints', async () => ({
      ...(await vi.importActual('@/lib/ai/fal-endpoints')),
      getFalEndpointIds: () =>
        opts.used ?? opts.prices.map((p) => p.endpointId),
    }));
    vi.doMock('@/lib/ai/fal-pricing-fetch', () => ({
      fetchFalCatalogIds: () =>
        Promise.resolve(opts.catalog ?? opts.prices.map((p) => p.endpointId)),
      fetchFalUnitPrices: (_key: string, ids: string[]) => {
        pricesRequested = ids;
        return Promise.resolve({
          prices: opts.prices,
          failedEndpoints: opts.priceFailures ?? [],
        });
      },
      fetchFalBilledRates: () => Promise.resolve(opts.billed ?? []),
      fetchFalTypicalUnits: (
        _key: string,
        prices: { endpointId: string }[]
      ) => {
        typicalCalledWith = prices;
        return Promise.resolve({
          typicalUnits: new Map(Object.entries(opts.typical ?? {})),
          failedEndpoints: new Set(opts.failed ?? []),
        });
      },
    }));
    return await import('@/lib/cron/refresh-fal-pricing');
  }

  const seedRow = (
    overrides: Partial<typeof modelPricing.$inferInsert> = {}
  ): typeof modelPricing.$inferInsert => ({
    provider: 'fal' as const,
    endpointId: 'fal-ai/flux-2',
    unit: 'compute_seconds',
    unitPriceMicros: 1670,
    typicalUnitsPerCall: 10,
    observedMedianUnits: null,
    observedSampleCount: 0,
    fetchedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    await db.delete(modelPricing);
    await db.delete(modelPricingHistory);
    await db.delete(modelUsageObservations);
    vi.resetAllMocks();
  });

  test('aborts on an empty price list instead of emptying the table', async () => {
    // The stale sweep deletes every row absent from the fetched list, so an
    // empty list wipes model_pricing and drops the platform back to the seed —
    // logging `endpoints: 0` at info level on the way out.
    await db.insert(modelPricing).values(seedRow());
    const { refreshFalPricing } = await load({ prices: [] });

    await expect(refreshFalPricing()).rejects.toThrow(/returned no prices/);
    expect(await db.select().from(modelPricing)).toHaveLength(1);
  });

  /** Five endpoints, so a single failure stays under the 25% abort ratio. */
  const fivePrices = [
    'fal-ai/flux-2',
    'fal-ai/a',
    'fal-ai/b',
    'fal-ai/c',
    'fal-ai/d',
  ].map((endpointId) => ({
    endpointId,
    unitPriceUsd: 0.00167,
    unit: 'compute_seconds',
  }));

  test('carries a stored typicalUnitsPerCall through a failed fetch', async () => {
    await db.insert(modelPricing).values(seedRow());
    const { refreshFalPricing } = await load({
      prices: fivePrices,
      failed: ['fal-ai/flux-2'],
    });

    await refreshFalPricing();

    const [row] = await db
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.endpointId, 'fal-ai/flux-2'));
    expect(row?.typicalUnitsPerCall).toBe(10);
  });

  test('writes prices and medians before throwing on a broad fetch failure', async () => {
    // Aborting up front discarded live prices that fetched cleanly AND the
    // observed medians, which come from our own D1 and don't depend on fal
    // being reachable — pinning the compute-seconds endpoints to the estimate
    // floor for the length of the outage despite samples already in hand.
    await db.insert(modelPricing).values(seedRow({ unitPriceMicros: 1 }));
    await db.insert(modelUsageObservations).values({
      provider: 'fal',
      endpointId: 'fal-ai/flux-2',
      unitsBilled: 294,
      numImages: 1,
    });
    const { refreshFalPricing } = await load({
      prices: fivePrices,
      failed: fivePrices.map((p) => p.endpointId),
    });

    await expect(refreshFalPricing()).rejects.toThrow(/were written/);

    const [row] = await db
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.endpointId, 'fal-ai/flux-2'));
    expect(row?.unitPriceMicros).toBe(1670); // live price landed
    expect(row?.observedMedianUnits).toBe(294); // median landed
    expect(row?.typicalUnitsPerCall).toBe(10); // stored figure preserved
  });

  test('nulls typicalUnitsPerCall when fal answers "no history"', async () => {
    // Distinct from the failure above: a real absence must not keep a stale
    // figure forever, which is the whole point of the ok/no-history/failed
    // split in the fetch client.
    await db.insert(modelPricing).values(seedRow());
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.00167,
          unit: 'compute_seconds',
        },
      ],
    });

    await refreshFalPricing();

    const [row] = await db.select().from(modelPricing);
    expect(row?.typicalUnitsPerCall).toBeNull();
  });

  test('appends history only when the unit price actually moves', async () => {
    await db.insert(modelPricing).values(seedRow());
    const unchanged = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.00167,
          unit: 'compute_seconds',
        },
      ],
    });
    await unchanged.refreshFalPricing();
    expect(await db.select().from(modelPricingHistory)).toHaveLength(0);

    const moved = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.005,
          unit: 'compute_seconds',
        },
      ],
    });
    await moved.refreshFalPricing();
    expect(await db.select().from(modelPricingHistory)).toHaveLength(1);
  });

  test('sweeps only the endpoints that disappeared', async () => {
    await db
      .insert(modelPricing)
      .values([seedRow(), seedRow({ endpointId: 'fal-ai/retired' })]);
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.00167,
          unit: 'compute_seconds',
        },
      ],
    });

    await refreshFalPricing();

    const rows = await db.select().from(modelPricing);
    expect(rows.map((r) => r.endpointId)).toEqual(['fal-ai/flux-2']);
  });

  test('discards observations when fal re-denominates an endpoint', async () => {
    // unitsBilled carries no unit of its own, so ~294 compute-second samples
    // and ~1 image samples would median together into a confident number two
    // orders of magnitude wrong — and being non-null it never hits the floor.
    await db.insert(modelPricing).values(seedRow());
    await db.insert(modelUsageObservations).values({
      provider: 'fal',
      endpointId: 'fal-ai/flux-2',
      unitsBilled: 294,
      numImages: 1,
    });
    const { refreshFalPricing } = await load({
      prices: [
        { endpointId: 'fal-ai/flux-2', unitPriceUsd: 0.02, unit: 'images' },
      ],
    });

    await refreshFalPricing();

    expect(await db.select().from(modelUsageObservations)).toHaveLength(0);
    const [row] = await db.select().from(modelPricing);
    expect(row?.observedMedianUnits).toBeNull();
  });

  test('aborts when a used endpoint has no price, keeping yesterday’s row', async () => {
    // Continuing would sweep the used endpoint's row and bill it $0.
    await db.insert(modelPricing).values(seedRow());
    const { refreshFalPricing } = await load({
      prices: [
        { endpointId: 'fal-ai/other', unitPriceUsd: 0.02, unit: 'images' },
      ],
      used: ['fal-ai/flux-2'],
    });

    await expect(refreshFalPricing()).rejects.toThrow(
      /no price for used endpoint/
    );
    expect(await db.select().from(modelPricing)).toHaveLength(1);
  });

  test('stores the whole catalog but fetches typical units only for used endpoints', async () => {
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.00167,
          unit: 'compute seconds',
        },
        { endpointId: 'some/unused-model', unitPriceUsd: 0.3, unit: 'videos' },
      ],
      used: ['fal-ai/flux-2'],
      catalog: ['fal-ai/flux-2', 'some/unused-model'],
    });

    const summary = await refreshFalPricing();

    expect(summary.endpoints).toBe(2);
    const rows = await db.select().from(modelPricing);
    expect(rows.map((r) => r.endpointId).sort()).toEqual([
      'fal-ai/flux-2',
      'some/unused-model',
    ]);
    // The estimate API allows ~1 req/s — the full catalog would take ~25 min.
    expect(typicalCalledWith?.map((p) => p.endpointId)).toEqual([
      'fal-ai/flux-2',
    ]);
  });

  test('asks about the union of fal catalog, modelschemas, unlisted, and used ids', async () => {
    // The Models feature runs anything modelschemas lists, and the seedance
    // enterprise endpoints appear in NO listing — all must still get a price.
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.00167,
          unit: 'compute seconds',
        },
      ],
      used: ['fal-ai/flux-2'],
      catalog: ['fal-ai/flux-2', 'fal-ai/only-on-fal'],
      modelsCatalog: ['fal-ai/only-on-modelschemas'],
    });

    await refreshFalPricing();

    expect(pricesRequested).toContain('fal-ai/only-on-fal');
    expect(pricesRequested).toContain('fal-ai/only-on-modelschemas');
    expect(pricesRequested).toContain(
      'bytedance/seedance-2.0/enterprise/text-to-video'
    );
    expect(pricesRequested).toContain('fal-ai/flux-2');
  });

  test('billed usage rates override the pricing API', async () => {
    // The Grok incident: pricing API reported "compute seconds" × $0.00017
    // while fal billed "units" × $0.01 — a ~59× under-charge. The bill wins.
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'xai/grok-imagine',
          unitPriceUsd: 0.00017,
          unit: 'compute seconds',
        },
      ],
      billed: [
        {
          endpointId: 'xai/grok-imagine',
          unit: 'units',
          unitPriceUsd: 0.01,
          costUsd: 0.4,
        },
      ],
    });

    await refreshFalPricing({ billingKey: 'admin-key' });

    const [row] = await db.select().from(modelPricing);
    expect(row?.unit).toBe('units');
    expect(row?.unitPriceMicros).toBe(10_000);
  });

  test('an endpoint only present in billed usage still gets a row', async () => {
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.012,
          unit: 'megapixels',
        },
      ],
      used: ['fal-ai/flux-2'],
      billed: [
        {
          endpointId: 'some/unpriced-but-billed',
          unit: 'units',
          unitPriceUsd: 0.02,
          costUsd: 1,
        },
      ],
    });

    await refreshFalPricing({ billingKey: 'admin-key' });

    const rows = await db.select().from(modelPricing);
    expect(rows.map((r) => r.endpointId).sort()).toEqual([
      'fal-ai/flux-2',
      'some/unpriced-but-billed',
    ]);
  });

  test('a bill-verified rate outlasts the advertised rate when usage ages out', async () => {
    // Verified last month; no billed data this run (usage aged out of the
    // 30-day window). The advertised rate — already proven wrong once — must
    // not overwrite the verified one.
    await db.insert(modelPricing).values(
      seedRow({
        endpointId: 'xai/grok-imagine',
        unit: 'units',
        unitPriceMicros: 10_000,
        typicalUnitsPerCall: null,
        rateVerifiedAt: new Date('2026-07-01T00:00:00Z'),
      })
    );
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'xai/grok-imagine',
          unitPriceUsd: 0.00017,
          unit: 'compute seconds',
        },
      ],
      billed: [], // nothing billed in the overlay window this run
    });

    await refreshFalPricing({ billingKey: 'admin-key' });

    const [row] = await db.select().from(modelPricing);
    expect(row?.unit).toBe('units');
    expect(row?.unitPriceMicros).toBe(10_000);
    expect(row?.rateVerifiedAt).toEqual(new Date('2026-07-01T00:00:00Z'));
  });

  test('without a billing key the pricing API stands, unverified', async () => {
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'xai/grok-imagine',
          unitPriceUsd: 0.00017,
          unit: 'compute seconds',
        },
      ],
      billed: [
        {
          endpointId: 'xai/grok-imagine',
          unit: 'units',
          unitPriceUsd: 0.01,
          costUsd: 0.4,
        },
      ],
    });

    await refreshFalPricing(); // no billingKey

    const [row] = await db.select().from(modelPricing);
    expect(row?.unit).toBe('compute seconds');
  });

  test('does not sweep an endpoint whose price fetch merely errored', async () => {
    await db
      .insert(modelPricing)
      .values([seedRow(), seedRow({ endpointId: 'fal-ai/erroring' })]);
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'fal-ai/flux-2',
          unitPriceUsd: 0.00167,
          unit: 'compute_seconds',
        },
      ],
      used: ['fal-ai/flux-2'],
      priceFailures: ['fal-ai/erroring'],
    });

    await refreshFalPricing();

    const rows = await db.select().from(modelPricing);
    expect(rows.map((r) => r.endpointId).sort()).toEqual([
      'fal-ai/erroring',
      'fal-ai/flux-2',
    ]);
  });

  test('writes the H3 Max typical-units fallback when fal has no history', async () => {
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'minimax/h3-max/image-to-video',
          unitPriceUsd: 0.025,
          unit: 'seconds',
        },
      ],
    });

    await refreshFalPricing();

    const [row] = await db.select().from(modelPricing);
    expect(row?.typicalUnitsPerCall).toBe(8);
  });

  test('H3 Max t2v inherits i2v billed rate when t2v has no usage', async () => {
    const { refreshFalPricing } = await load({
      prices: [
        {
          endpointId: 'minimax/h3-max/image-to-video',
          unitPriceUsd: 0.00017,
          unit: 'compute seconds',
        },
        {
          endpointId: 'minimax/h3-max/text-to-video',
          unitPriceUsd: 0.00017,
          unit: 'compute seconds',
        },
      ],
      billed: [
        {
          endpointId: 'minimax/h3-max/image-to-video',
          unit: 'seconds',
          unitPriceUsd: 0.025,
          costUsd: 1.2,
        },
      ],
    });

    await refreshFalPricing({ billingKey: 'admin-key' });

    const rows = await db.select().from(modelPricing);
    const t2v = rows.find(
      (r) => r.endpointId === 'minimax/h3-max/text-to-video'
    );
    expect(t2v?.unit).toBe('seconds');
    expect(t2v?.unitPriceMicros).toBe(25_000);
    expect(t2v?.rateVerifiedAt).not.toBeNull();
    expect(t2v?.typicalUnitsPerCall).toBe(8);
  });
});

describe('computeLedgerObservedUnits', () => {
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client });

  beforeEach(async () => {
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    await db
      .insert(teams)
      .values({ id: 'team-1', name: 't', slug: 'team-1-slug' })
      .onConflictDoNothing();
    await db.delete(transactions);
    await db.delete(modelUsageObservations);
  });

  test('reads unitsBilled from transaction metadata when observations are empty', async () => {
    await db.insert(transactions).values({
      id: 'tx-1',
      teamId: 'team-1',
      type: 'credit_usage',
      amount: -200_000,
      balanceAfter: 0,
      metadata: {
        endpointId: 'minimax/h3-max/image-to-video',
        unitsBilled: 8,
      },
    });

    const { observed, samples } = await computeLedgerObservedUnits(db);
    expect(samples).toBe(1);
    expect(observed.get('minimax/h3-max/image-to-video')).toEqual({
      medianUnits: 8,
      sampleCount: 1,
    });
  });

  test('observations outrank the ledger so a generation is not counted twice', async () => {
    await db.insert(modelUsageObservations).values({
      provider: 'fal',
      endpointId: 'minimax/h3-max/image-to-video',
      unitsBilled: 8,
      numImages: 1,
    });
    await db.insert(transactions).values({
      id: 'tx-1',
      teamId: 'team-1',
      type: 'credit_usage',
      amount: -200_000,
      balanceAfter: 0,
      metadata: {
        endpointId: 'minimax/h3-max/image-to-video',
        unitsBilled: 99,
      },
    });

    const { observed } = await collectObservedUnits(db);
    expect(observed.get('minimax/h3-max/image-to-video')).toEqual({
      medianUnits: 8,
      sampleCount: 1,
    });
  });
});
