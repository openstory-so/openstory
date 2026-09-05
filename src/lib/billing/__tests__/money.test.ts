import { describe, expect, test } from 'vitest';
import {
  usdToMicros,
  microsToUsd,
  microsToDisplayUsd,
  addMicros,
  subtractMicros,
  multiplyMicros,
  micros,
  ZERO_MICROS,
} from '@/shared/billing/money';

const m = micros;

describe('usdToMicros', () => {
  test('converts whole dollars', () => {
    expect(usdToMicros(1)).toBe(m(1_000_000));
    expect(usdToMicros(10)).toBe(m(10_000_000));
    expect(usdToMicros(1000)).toBe(m(1_000_000_000));
  });

  test('converts fractional dollars', () => {
    expect(usdToMicros(0.01)).toBe(m(10_000));
    expect(usdToMicros(0.5)).toBe(m(500_000));
    expect(usdToMicros(12.34)).toBe(m(12_340_000));
  });

  test('handles 0.1 + 0.2 precision correctly', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
    const a = usdToMicros(0.1);
    const b = usdToMicros(0.2);
    expect(addMicros(a, b)).toBe(usdToMicros(0.3));
  });

  test('rounds sub-microdollar fractions', () => {
    // $0.000001 = 1 microdollar, but $0.0000005 should round to 1
    expect(usdToMicros(0.0000005)).toBe(m(1));
    // $0.0000004 should round to 0
    expect(usdToMicros(0.0000004)).toBe(m(0));
  });

  test('handles zero', () => {
    expect(usdToMicros(0)).toBe(m(0));
  });

  test('handles negative values', () => {
    expect(usdToMicros(-5.5)).toBe(m(-5_500_000));
  });
});

describe('microsToUsd', () => {
  test('converts back to USD', () => {
    expect(microsToUsd(m(1_000_000))).toBe(1);
    expect(microsToUsd(m(10_000))).toBe(0.01);
    expect(microsToUsd(m(12_340_000))).toBe(12.34);
  });

  test('zero roundtrips', () => {
    expect(microsToUsd(ZERO_MICROS)).toBe(0);
  });
});

describe('microsToDisplayUsd', () => {
  test('formats normal amounts with 2 decimals', () => {
    expect(microsToDisplayUsd(m(12_340_000))).toBe('$12.34');
    expect(microsToDisplayUsd(m(100_000_000))).toBe('$100.00');
    expect(microsToDisplayUsd(m(10_000))).toBe('$0.01');
  });

  test('formats very small amounts with 4 decimals', () => {
    expect(microsToDisplayUsd(m(1_000))).toBe('$0.0010');
    expect(microsToDisplayUsd(m(500))).toBe('$0.0005');
  });

  test('formats zero', () => {
    expect(microsToDisplayUsd(ZERO_MICROS)).toBe('$0.00');
  });

  test('formats negative amounts', () => {
    expect(microsToDisplayUsd(m(-5_500_000))).toBe('$-5.50');
  });
});

describe('arithmetic', () => {
  test('addMicros', () => {
    const a = m(100_000);
    const b = m(200_000);
    expect(addMicros(a, b)).toBe(m(300_000));
  });

  test('subtractMicros', () => {
    const a = m(500_000);
    const b = m(200_000);
    expect(subtractMicros(a, b)).toBe(m(300_000));
  });

  test('multiplyMicros rounds correctly', () => {
    const cost = m(100_000); // $0.10
    // 5% markup
    expect(multiplyMicros(cost, 1.05)).toBe(m(105_000));
  });

  test('multiplyMicros rounds to nearest integer', () => {
    const cost = m(100_001);
    // Multiply by 1/3 → 33333.666... → rounds to 33334
    expect(multiplyMicros(cost, 1 / 3)).toBe(m(33334));
  });

  test('ZERO_MICROS is identity for addition', () => {
    const a = m(42_000_000);
    expect(addMicros(a, ZERO_MICROS)).toBe(a);
  });

  test('large values stay exact', () => {
    // $10,000 = 10 billion microdollars — still within safe integer range
    const large = usdToMicros(10_000);
    expect(large).toBe(m(10_000_000_000));
    expect(microsToUsd(large)).toBe(10_000);
  });
});
