import { describe, expect, it } from 'vitest';
import { micros, ZERO_MICROS } from '@/shared/billing/money';
import { extractImageCost } from '../workflow-deduction';

describe('extractImageCost', () => {
  it('returns metadata.cost when present', () => {
    expect(extractImageCost({ cost: micros(500_000) })).toBe(micros(500_000));
  });

  it('returns ZERO_MICROS when cost is missing', () => {
    expect(extractImageCost({})).toBe(ZERO_MICROS);
  });
});
