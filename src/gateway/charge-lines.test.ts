import { describe, expect, it } from 'vitest';
import { micros } from '@/billing/money';
import { GATEWAY_PLATFORM_FEE_BPS, gatewayCharge } from './charge-lines';

const sum = (lines: { amountMicros: number }[]) =>
  lines.reduce((total, line) => total + line.amountMicros, 0);

describe('gatewayCharge', () => {
  it('ships with the platform fee off', () => {
    expect(GATEWAY_PLATFORM_FEE_BPS).toBe(0);
  });

  it('writes no fee line when the fee is zero', () => {
    expect(
      gatewayCharge({ providerCostMicros: micros(12_345), platformFeeBps: 0 })
    ).toEqual({
      totalMicros: 12_345,
      lines: [
        {
          kind: 'provider_cost',
          amountMicros: 12_345,
          payeeOrganizationId: null,
        },
      ],
    });
  });

  it('adds a non-zero fee to the platform, and the lines sum to the total', () => {
    const charge = gatewayCharge({
      providerCostMicros: micros(1_000_000),
      platformFeeBps: 250,
    });
    expect(charge.lines).toEqual([
      {
        kind: 'provider_cost',
        amountMicros: 1_000_000,
        payeeOrganizationId: null,
      },
      { kind: 'platform_fee', amountMicros: 25_000, payeeOrganizationId: null },
    ]);
    expect(charge.totalMicros).toBe(1_025_000);
  });

  it('rounds each line half up to a whole microdollar, deterministically', () => {
    // 3 * 5% = 0.15 → 0; 10 * 5% = 0.5 → 1; 29 * 5% = 1.45 → 1; 30 * 5% = 1.5 → 2.
    const fee = (cost: number) =>
      gatewayCharge({
        providerCostMicros: micros(cost),
        platformFeeBps: 500,
      }).lines.find((line) => line.kind === 'platform_fee')?.amountMicros ?? 0;
    expect([3, 10, 29, 30].map(fee)).toEqual([0, 1, 1, 2]);
    for (const cost of [1, 7, 333, 999_999, 123_456_789]) {
      const charge = gatewayCharge({
        providerCostMicros: micros(cost),
        platformFeeBps: 733,
      });
      expect(sum(charge.lines)).toBe(charge.totalMicros);
      expect(
        charge.lines.every((line) => Number.isInteger(line.amountMicros))
      ).toBe(true);
    }
  });

  it('takes an app margin to its payee without changing the other lines', () => {
    const charge = gatewayCharge({
      providerCostMicros: micros(200_000),
      platformFeeBps: 100,
      appMargin: { bps: 1_500, payeeOrganizationId: 'app-org' },
    });
    expect(charge.lines).toEqual([
      {
        kind: 'provider_cost',
        amountMicros: 200_000,
        payeeOrganizationId: null,
      },
      { kind: 'platform_fee', amountMicros: 2_000, payeeOrganizationId: null },
      {
        kind: 'app_margin',
        amountMicros: 30_000,
        payeeOrganizationId: 'app-org',
      },
    ]);
    expect(charge.totalMicros).toBe(232_000);
  });

  it('rounds exactly where cost times rate passes 2^53', () => {
    const fee = (cost: number, bps: number) =>
      gatewayCharge({
        providerCostMicros: micros(cost),
        platformFeeBps: bps,
      }).lines.find((line) => line.kind === 'platform_fee')?.amountMicros;
    // 4_000_000_000_000_003 * 9_999 is far past 2^53; float math gives …004.
    expect(fee(4_000_000_000_000_003, 9_999)).toBe(3_999_600_000_000_003);
    expect(() =>
      gatewayCharge({
        providerCostMicros: micros(Number.MAX_SAFE_INTEGER),
        platformFeeBps: 1,
      })
    ).toThrow('safe integer');
  });

  it('is empty for a zero cost', () => {
    expect(
      gatewayCharge({ providerCostMicros: micros(0), platformFeeBps: 500 })
    ).toEqual({ totalMicros: 0, lines: [] });
  });

  it('refuses a fractional cost or an out-of-range rate', () => {
    expect(() =>
      gatewayCharge({ providerCostMicros: micros(1.5), platformFeeBps: 0 })
    ).toThrow('non-negative integer');
    expect(() =>
      gatewayCharge({ providerCostMicros: micros(1), platformFeeBps: -1 })
    ).toThrow('platformFeeBps');
    expect(() =>
      gatewayCharge({ providerCostMicros: micros(1), platformFeeBps: 2.5 })
    ).toThrow('platformFeeBps');
  });
});
