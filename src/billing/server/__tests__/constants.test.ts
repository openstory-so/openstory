import { describe, expect, it } from 'vitest';
import {
  MIN_TOPUP_AMOUNT_USD,
  formatPlatformFeePercent,
  platformFeeUsd,
  splitCheckoutAmounts,
  totalCheckoutCents,
  totalCheckoutUsd,
} from '@/billing/constants';
import { micros, usdToMicros } from '@/billing/money';

describe('billing constants', () => {
  it('minimum top-up is $5', () => {
    expect(MIN_TOPUP_AMOUNT_USD).toBe(5);
  });

  it('applies platform fee only at purchase', () => {
    expect(platformFeeUsd(100)).toBeCloseTo(7);
    expect(totalCheckoutUsd(100)).toBeCloseTo(107);
    expect(formatPlatformFeePercent()).toBe('7%');
  });

  it('splits checkout into credit and fee line items', () => {
    expect(splitCheckoutAmounts(100)).toEqual({
      creditUsd: 100,
      feeUsd: 7,
      totalUsd: 107,
    });
  });

  it('rounds fee to cents for Stripe', () => {
    expect(splitCheckoutAmounts(10)).toEqual({
      creditUsd: 10,
      feeUsd: 0.7,
      totalUsd: 10.7,
    });
  });

  it('rounds fee from credit cents, not float USD', () => {
    // 1001¢ × 7% = 70.07 → 70¢
    expect(splitCheckoutAmounts(10.01)).toEqual({
      creditUsd: 10.01,
      feeUsd: 0.7,
      totalUsd: 10.71,
    });
  });

  it('totalCheckoutCents returns integer cents aligned with splitCheckoutAmounts', () => {
    expect(totalCheckoutCents(usdToMicros(100))).toBe(10_700);
    expect(totalCheckoutCents(usdToMicros(10))).toBe(1_070);
    // $10.50 → 1050¢ × 7% = 73.5 → 74¢ fee → 1124¢
    expect(totalCheckoutCents(micros(10_500_000))).toBe(1_124);
    expect(Number.isInteger(totalCheckoutCents(micros(10_010_000)))).toBe(true);
  });
});
