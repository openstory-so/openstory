import { describe, expect, it } from 'vitest';
import { billedQuantity } from './billed-quantity';

describe('billedQuantity', () => {
  it('reads the quantity fal reports as billed units', () => {
    expect(billedQuantity({ billed: { quantity: 5, unit: 'units' } })).toBe(5);
  });

  it('is missing when the provider billed only in tokens', () => {
    expect(billedQuantity({ promptTokens: 10 })).toBeUndefined();
    expect(billedQuantity(undefined)).toBeUndefined();
    expect(
      billedQuantity({ billed: { quantity: Number.NaN, unit: 'units' } })
    ).toBeUndefined();
  });
});
