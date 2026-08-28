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
async function loadWithRows(rows: Row[], env: Record<string, string> = {}) {
  vi.resetModules(); // the module caches its map per isolate
  vi.doMock('#db-client', () => ({
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    }),
  }));
  vi.doMock('#env', () => ({ getEnv: () => env }));
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
        endpointId: 'xai/grok-imagine',
        unit: 'compute seconds',
        observedMedianUnits: 294,
        observedSampleCount: 7,
      }),
    ]);

    const pricing = (await getEffectiveFalPricing())['xai/grok-imagine'];
    expect(pricing?.observed).toEqual({ medianUnits: 294, sampleCount: 7 });
  });

  it('returns no fal rows (not a throw) when the table is empty', async () => {
    // Local dev / fresh deploy before the first refresh: estimates gate on
    // the floor and billing reports $0 — visible, not fatal.
    const { getEffectiveFalPricing } = await loadWithRows([]);
    const map = await getEffectiveFalPricing();
    // The BytePlus card is static, so it survives an empty table by design
    // (#1157) — that is the whole point of not seeding it into D1. Assert no
    // FAL endpoint appears rather than no entry at all.
    expect(Object.keys(map).filter((id) => id.includes('/'))).toEqual([]);
  });

  it('keeps the static BytePlus rate card when the fal table is empty', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([]);
    const map = await getEffectiveFalPricing();
    expect(map['dreamina-seedance-2-5-260628']).toEqual({
      unitPrice: 10_700,
      unit: '1000 tokens',
    });
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

/**
 * Route aliasing (#1157). Every estimator and the client's ActionCost payload
 * look a model up by its FAL catalog id, so when the platform routes that
 * model to Ark the map has to answer with the Ark rate — otherwise every
 * pre-flight number quotes a provider we are not billing.
 */
describe('BytePlus route aliasing', () => {
  const SEEDANCE_FAL = 'bytedance/seedance-2.5/image-to-video';
  const SEEDANCE_REF = 'bytedance/seedance-2.5/reference-to-video';
  const SEEDREAM_FAL = 'bytedance/seedream/v5/pro/text-to-image';

  const falRows = [
    row({ endpointId: SEEDANCE_FAL, unit: '1000 tokens', unitPriceMicros: 99 }),
    row({ endpointId: SEEDANCE_REF, unit: '1000 tokens', unitPriceMicros: 99 }),
    row({ endpointId: SEEDREAM_FAL, unit: 'images', unitPriceMicros: 99 }),
  ];

  beforeEach(() => {
    vi.resetModules();
  });

  it('leaves fal rates alone when no Ark key is configured', async () => {
    const { getEffectiveFalPricing } = await loadWithRows(falRows);
    const map = await getEffectiveFalPricing();
    expect(map[SEEDANCE_FAL]?.unitPrice).toBe(99);
    expect(map[SEEDREAM_FAL]?.unitPrice).toBe(99);
  });

  it('points the fal ids at the Ark rate when Ark is configured', async () => {
    const { getEffectiveFalPricing } = await loadWithRows(falRows, {
      ARK_API_KEY: 'ark-test',
    });
    const map = await getEffectiveFalPricing();
    expect(map[SEEDANCE_FAL]?.unitPrice).toBe(10_700);
    expect(map[SEEDREAM_FAL]?.unitPrice).toBe(90_000);
  });

  // Seedance with cast/element refs bills on a separate fal endpoint; on Ark
  // it is one model id, so this endpoint has to alias too or a referenced shot
  // silently quotes the fal rate.
  it('aliases the reference-to-video endpoint as well', async () => {
    const { getEffectiveFalPricing } = await loadWithRows(falRows, {
      ARK_API_KEY: 'ark-test',
    });
    expect((await getEffectiveFalPricing())[SEEDANCE_REF]?.unitPrice).toBe(
      10_700
    );
  });

  it('leaves models with no BytePlus via on their fal rate', async () => {
    const { getEffectiveFalPricing } = await loadWithRows(
      [
        row({
          endpointId: 'fal-ai/veo3.1/image-to-video',
          unitPriceMicros: 77,
        }),
      ],
      { ARK_API_KEY: 'ark-test' }
    );
    const map = await getEffectiveFalPricing();
    expect(map['fal-ai/veo3.1/image-to-video']?.unitPrice).toBe(77);
  });
});

describe('H3 Max t2v sibling rate (#1382)', () => {
  const I2V = 'minimax/h3-max/image-to-video';
  const T2V = 'minimax/h3-max/text-to-video';

  beforeEach(() => {
    vi.resetModules();
  });

  it('fills typical 8 when the i2v row has no fal history', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([
      row({
        endpointId: I2V,
        unit: 'seconds',
        unitPriceMicros: 25_000,
        typicalUnitsPerCall: null,
      }),
    ]);
    const pricing = (await getEffectiveFalPricing())[I2V];
    expect(pricing?.typicalUnitsPerCall).toBe(8);
  });

  it('points t2v at i2v’s billed seconds rate instead of compute seconds', async () => {
    const { getEffectiveFalPricing } = await loadWithRows([
      row({
        endpointId: I2V,
        unit: 'seconds',
        unitPriceMicros: 25_000,
        typicalUnitsPerCall: 8,
      }),
      row({
        endpointId: T2V,
        unit: 'compute seconds',
        unitPriceMicros: 170,
        typicalUnitsPerCall: null,
      }),
    ]);
    const map = await getEffectiveFalPricing();
    expect(map[T2V]).toEqual({
      unitPrice: micros(25_000),
      unit: 'seconds',
      typicalUnitsPerCall: 8,
    });
  });
});
