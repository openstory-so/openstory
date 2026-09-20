import { describe, expect, test } from 'vitest';
import { getFalEndpointIds } from '@/models/fal-endpoints';
import {
  isCatalogStub,
  LOCAL_FAL_PRICING_SEED,
  unseededFalEndpoints,
} from './seed-model-pricing';

describe('local/test model_pricing seed', () => {
  test('covers every fal endpoint we call', () => {
    expect(unseededFalEndpoints()).toEqual([]);
  });

  test('does not seed endpoints we do not call', () => {
    const used = new Set(getFalEndpointIds());
    const extra = Object.keys(LOCAL_FAL_PRICING_SEED).filter(
      (id) => !used.has(id)
    );
    expect(extra).toEqual([]);
  });

  test('a no-signal "compute seconds" row is a stub; one with a typical is not', () => {
    const row = {
      unit: 'compute seconds',
      unitPriceMicros: 170,
      typicalUnitsPerCall: null,
      observedSampleCount: 0,
    };
    expect(isCatalogStub(row)).toBe(true);
    expect(isCatalogStub({ ...row, typicalUnitsPerCall: 8 })).toBe(false);
    expect(isCatalogStub({ ...row, observedSampleCount: 3 })).toBe(false);
  });
});
