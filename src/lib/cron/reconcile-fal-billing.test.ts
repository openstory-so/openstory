/**
 * Guards for the hourly billing reconcile (#1069): cron wiring, rate
 * correction from per-request billed costs, and drift detection between what
 * we charged and what fal billed.
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  modelPricing,
  modelPricingHistory,
  teams,
  transactions,
} from '@/lib/db/schema';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

describe('fal billing reconcile cron wiring', () => {
  const wrangler = readFileSync('wrangler.jsonc', 'utf-8');

  test('the cron expression is registered in the default block and [env.production]', async () => {
    const { FAL_BILLING_RECONCILE_CRON } =
      await import('@/lib/cron/reconcile-fal-billing');
    const defaultCrons = wrangler.slice(0, wrangler.indexOf('"env"'));
    expect(defaultCrons).toContain(FAL_BILLING_RECONCILE_CRON);
    const productionBlock = wrangler.slice(wrangler.indexOf('"production"'));
    expect(productionBlock).toContain(FAL_BILLING_RECONCILE_CRON);
  });

  test('the expression is distinct from the other crons', async () => {
    const { FAL_BILLING_RECONCILE_CRON } =
      await import('@/lib/cron/reconcile-fal-billing');
    const { FAL_PRICING_CRON } = await import('@/lib/cron/refresh-fal-pricing');
    expect(FAL_BILLING_RECONCILE_CRON).not.toBe(FAL_PRICING_CRON);
    expect(FAL_BILLING_RECONCILE_CRON).not.toBe('*/5 * * * *');
  });
});

describe('reconcileFalBilling', () => {
  const client = createClient({ url: ':memory:' });
  const db = drizzle({ client });

  const driftReports: unknown[] = [];

  type EventFixture = {
    request_id: string;
    endpoint_id: string;
    timestamp: string;
    output_units: number;
    unit_price: number;
    cost_total: number;
    cost_estimate_nano_usd: number;
  };

  async function load(events: EventFixture[]) {
    vi.resetModules();
    driftReports.length = 0;
    vi.doMock('#db-client', () => ({ getDb: () => db }));
    vi.doMock('#env', () => ({ getEnv: () => ({}) }));
    vi.doMock('@/lib/billing/billing-observability', () => ({
      reportBillingDrift: (ctx: unknown) => driftReports.push(ctx),
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ billing_events: events }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    );
    return await import('@/lib/cron/reconcile-fal-billing');
  }

  function event(overrides: Partial<EventFixture> = {}): EventFixture {
    return {
      request_id: 'req-1',
      endpoint_id: 'example/compute-image',
      timestamp: new Date().toISOString(),
      output_units: 7,
      unit_price: 0.01,
      cost_total: 0.07,
      cost_estimate_nano_usd: 70_000_000,
      ...overrides,
    };
  }

  function pricingRow(
    overrides: Partial<typeof modelPricing.$inferInsert> = {}
  ): typeof modelPricing.$inferInsert {
    return {
      provider: 'fal',
      endpointId: 'example/compute-image',
      unit: 'compute seconds',
      unitPriceMicros: 170,
      typicalUnitsPerCall: null,
      observedMedianUnits: null,
      observedSampleCount: 0,
      rateVerifiedAt: null,
      fetchedAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  async function insertUsageTx(opts: {
    requestId: string;
    costMicros: number;
  }): Promise<string> {
    const id = `tx-${opts.requestId}`;
    await db.insert(transactions).values({
      id,
      teamId: 'team-1',
      type: 'credit_usage',
      amount: -opts.costMicros,
      balanceAfter: 0,
      metadata: {
        costMicros: opts.costMicros,
        requestId: opts.requestId,
        endpointId: 'example/compute-image',
      },
    });
    return id;
  }

  beforeEach(async () => {
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    // transactions.teamId FK needs a parent row.
    await db
      .insert(teams)
      .values({ id: 'team-1', name: 't', slug: 'team-1-slug' })
      .onConflictDoNothing();
    await db.delete(modelPricing);
    await db.delete(modelPricingHistory);
    await db.delete(transactions);
    vi.unstubAllGlobals();
  });

  test('returns null (with an error log) when no billing key is configured', async () => {
    const { reconcileFalBilling } = await load([]);
    expect(await reconcileFalBilling()).toBeNull();
  });

  test('corrects a stale rate from the billed unit price and stamps rateVerifiedAt', async () => {
    // The compute-second model shape: stored 170 micros/unit, bill says 10,000 micros/unit.
    await db.insert(modelPricing).values(pricingRow());
    const { reconcileFalBilling } = await load([event()]);

    const summary = await reconcileFalBilling({ billingKey: 'admin' });

    expect(summary?.rateCorrections).toBe(1);
    const [row] = await db.select().from(modelPricing);
    expect(row?.unitPriceMicros).toBe(10_000);
    expect(row?.rateVerifiedAt).not.toBeNull();
    expect(await db.select().from(modelPricingHistory)).toHaveLength(1);
  });

  test('a matching rate is confirmed, not corrected', async () => {
    await db
      .insert(modelPricing)
      .values(pricingRow({ unit: 'units', unitPriceMicros: 10_000 }));
    const { reconcileFalBilling } = await load([event()]);

    const summary = await reconcileFalBilling({ billingKey: 'admin' });

    expect(summary?.rateCorrections).toBe(0);
    const [row] = await db.select().from(modelPricing);
    expect(row?.rateVerifiedAt).not.toBeNull();
    expect(await db.select().from(modelPricingHistory)).toHaveLength(0);
  });

  test('reports drift when the charge disagrees with the billed cost', async () => {
    await db
      .insert(modelPricing)
      .values(pricingRow({ unit: 'units', unitPriceMicros: 10_000 }));
    // We charged $0.00119 (the old wrong rate); fal billed $0.07.
    await insertUsageTx({ requestId: 'req-1', costMicros: 1_190 });
    const { reconcileFalBilling } = await load([event()]);

    const summary = await reconcileFalBilling({ billingKey: 'admin' });

    expect(summary?.matchedTransactions).toBe(1);
    expect(summary?.drifts).toBe(1);
    expect(driftReports).toHaveLength(1);
    expect(driftReports[0]).toMatchObject({
      requestId: 'req-1',
      chargedMicros: 1_190,
      billedMicros: 70_000,
    });
  });

  test('an exact charge produces no drift report', async () => {
    await db
      .insert(modelPricing)
      .values(pricingRow({ unit: 'units', unitPriceMicros: 10_000 }));
    await insertUsageTx({ requestId: 'req-1', costMicros: 70_000 });
    const { reconcileFalBilling } = await load([event()]);

    const summary = await reconcileFalBilling({ billingKey: 'admin' });

    expect(summary?.matchedTransactions).toBe(1);
    expect(summary?.drifts).toBe(0);
    expect(driftReports).toHaveLength(0);
  });

  test('events with no matching transaction are counted, not reported', async () => {
    // BYOK, scripts, and unpriced $0 charges legitimately have no tx.
    const { reconcileFalBilling } = await load([event()]);
    const summary = await reconcileFalBilling({ billingKey: 'admin' });
    expect(summary?.unmatchedEvents).toBe(1);
    expect(driftReports).toHaveLength(0);
  });
});
