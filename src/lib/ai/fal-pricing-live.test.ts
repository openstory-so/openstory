/**
 * `model_pricing` is the only pricing record — these tests pin how rows
 * become the runtime map (#1069).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micros } from '@/lib/billing/money';

type Row = {
  provider: string;
  endpointId: string;
  unit: string;
  unitPriceMicros: number;
  typicalUnitsPerCall: number | null;
  observedMedianUnits: number | null;
  observedSampleCount: number;
  fetchedAt: Date;
  updatedAt: Date;
};

function row(overrides: Partial<Row> & Pick<Row, 'endpointId'>): Row {
  return {
    provider: 'fal',
    unit: 'images',
    unitPriceMicros: 1_000_000,
    typicalUnitsPerCall: null,
    observedMedianUnits: null,
    observedSampleCount: 0,
    fetchedAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Stubs the one query shape `getEffectiveFalPricing` issues. */
async function loadWithRows(rows: Row[]) {
  vi.resetModules(); // the module caches its map per isolate
  vi.doMock('#db-client', () => ({
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    }),
  }));
  return await import('@/lib/ai/fal-pricing-live');
}

describe('getEffectiveFalPricing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('builds pricing from rows, with a null typicalUnitsPerCall as "no history"', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([
      row({
        endpointId: 'openai/gpt-image-2',
        unit: 'units',
        typicalUnitsPerCall: null,
      }),
    ]);

    const pricing = (await getEffectiveFalPricing())['openai/gpt-image-2'];
    expect(pricing?.unit).toBe('units');
    expect(pricing?.unitPrice).toBe(micros(1_000_000));
    expect(pricing?.typicalUnitsPerCall).toBeUndefined();
  });

  it('drops an endpoint with two rows rather than billing an arbitrary rate', async () => {
    // Legitimate mid-re-denomination state: the map is keyed by endpointId
    // alone, so picking either row would multiply unitsBilled by an arbitrary
    // rate. Gone from the map, it gates on the floor and reports a $0 charge —
    // both visible.
    const { getEffectiveFalPricing } = await loadWithRows([
      row({ endpointId: 'openai/gpt-image-2', unit: 'images' }),
      row({
        endpointId: 'openai/gpt-image-2',
        unit: 'compute seconds',
        unitPriceMicros: 170,
      }),
    ]);

    const map = await getEffectiveFalPricing();
    expect(map['openai/gpt-image-2']).toBeUndefined();
  });

  it('omits `observed` entirely when there is no median', async () => {
    // An `observed` with a null median would put the burden of rejecting it
    // on isUsableCount, one `??` away from a $0 gate.
    const { getEffectiveFalPricing } = await loadWithRows([
      row({
        endpointId: 'openai/gpt-image-2',
        observedMedianUnits: null,
        observedSampleCount: 12,
      }),
    ]);

    const pricing = (await getEffectiveFalPricing())['openai/gpt-image-2'];
    expect(pricing?.observed).toBeUndefined();
  });

  it('carries the median and its sample count together', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([
      row({
        endpointId: 'example/compute-image',
        unit: 'compute seconds',
        observedMedianUnits: 294,
        observedSampleCount: 7,
      }),
    ]);

    const pricing = (await getEffectiveFalPricing())['example/compute-image'];
    expect(pricing?.observed).toEqual({ medianUnits: 294, sampleCount: 7 });
  });

  it('returns an empty map (not a throw) when the table is empty', async () => {
    // Local dev / fresh deploy before the first refresh: estimates gate on
    // the floor and billing reports $0 — visible, not fatal.
    const { getEffectiveFalPricing } = await loadWithRows([]);
    expect(await getEffectiveFalPricing()).toEqual({});
  });

  it('reports when the newest row was fetched', async () => {
    const older = new Date('2026-07-01T00:00:00Z');
    const newer = new Date('2026-07-02T00:00:00Z');
    const { getFalPricingUpdatedAt } = await loadWithRows([
      row({ endpointId: 'a/b', fetchedAt: older }),
      row({ endpointId: 'c/d', fetchedAt: newer }),
    ]);
    expect(await getFalPricingUpdatedAt()).toEqual(newer);
  });
});
