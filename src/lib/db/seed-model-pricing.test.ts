import { describe, expect, test } from 'vitest';
import { getFalEndpointIds } from '@/lib/ai/fal-endpoints';
import {
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
});
