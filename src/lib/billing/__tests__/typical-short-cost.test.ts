import { describe, expect, it } from 'vitest';
import { TEST_FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import { TYPICAL_SHORT_COST_USD } from '@/shared/billing/constants';
import { typicalShortCostUsd } from '@/components/billing/typical-short-cost';

describe('typicalShortCostUsd', () => {
  it('prices a default short from live pricing', () => {
    // Fixture rates are cheaper than production, so assert the shape, not the
    // number: a real quote that differs from the static literal.
    const usd = typicalShortCostUsd(TEST_FAL_PRICING);
    expect(usd).toBeGreaterThan(1);
    expect(usd).not.toBe(TYPICAL_SHORT_COST_USD);
  });

  it('falls back to the static estimate with no priced endpoints', () => {
    expect(typicalShortCostUsd(null)).toBe(TYPICAL_SHORT_COST_USD);
    // Empty table = every endpoint at its gate floor (~$1), not a real quote.
    expect(typicalShortCostUsd({})).toBe(TYPICAL_SHORT_COST_USD);
  });
});
