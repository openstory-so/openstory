import { describe, expect, it } from 'vitest';
import { applyBalanceEvent } from './use-billing-balance-realtime';
import {
  BILLING_BALANCE_KEY,
  billingBalanceQueryOptions,
  keepNewestBalance,
} from './use-billing-balance';
import { QueryClient } from '@tanstack/react-query';

type Prev = NonNullable<Parameters<typeof applyBalanceEvent>[0]>;

const prev: Prev = {
  teamId: 'team_1',
  balance: 10,
  availableUsd: 8,
  reservedUsd: 2,
  asOfMs: 1_000,
  stripeEnabled: true,
  hasUsedCredits: true,
  hasSignupGrant: false,
  hasOtherCredits: true,
  autoTopUp: {
    enabled: false,
    thresholdUsd: null,
    amountUsd: null,
    lastFailure: null,
  },
  hasPaymentMethod: false,
};

const usage = {
  teamId: 'team_1',
  balanceUsd: 9,
  availableUsd: 7,
  reservedUsd: 2,
  asOfMs: 2_000,
  amountUsd: -1,
  transactionId: 'tx_1',
  type: 'credit_usage' as const,
};

describe('applyBalanceEvent (#1881)', () => {
  it('settles a full usage event without a refetch', () => {
    const { next, refetch } = applyBalanceEvent(prev, usage);
    expect(refetch).toBe(false);
    expect(next).toMatchObject({
      balance: 9,
      availableUsd: 7,
      reservedUsd: 2,
      asOfMs: 2_000,
    });
  });

  it('settles a hold-only snapshot without a refetch', () => {
    const { transactionId: _, type: __, ...hold } = usage;
    expect(applyBalanceEvent(prev, hold).refetch).toBe(false);
  });

  it('flips hasUsedCredits on the first usage and settles it', () => {
    const { next, refetch } = applyBalanceEvent(
      { ...prev, hasUsedCredits: false },
      usage
    );
    expect(next?.hasUsedCredits).toBe(true);
    expect(refetch).toBe(false);
  });

  it('refetches while the first usage has not been seen', () => {
    const { transactionId: _, type: __, ...hold } = usage;
    expect(
      applyBalanceEvent({ ...prev, hasUsedCredits: false }, hold).refetch
    ).toBe(true);
  });

  it('refetches on a purchase, refund, or adjustment', () => {
    for (const type of [
      'credit_purchase',
      'credit_refund',
      'credit_adjustment',
    ] as const) {
      expect(applyBalanceEvent(prev, { ...usage, type }).refetch).toBe(true);
    }
  });

  it('recomputes hasOtherCredits from the new balance', () => {
    const { next } = applyBalanceEvent(prev, {
      ...usage,
      balanceUsd: 0,
      availableUsd: 0,
      reservedUsd: 0,
    });
    expect(next?.hasOtherCredits).toBe(false);
  });

  it('refetches when nothing is cached', () => {
    expect(applyBalanceEvent(undefined, usage)).toEqual({
      next: undefined,
      refetch: true,
    });
  });
});

describe('keepNewestBalance (#1881)', () => {
  it('keeps the cache when an older snapshot lands', () => {
    const newer = { ...prev, balance: 7, asOfMs: 3_000 };
    expect(keepNewestBalance(newer, prev)).toBe(newer);
  });

  it('takes a newer snapshot', () => {
    const newer = { ...prev, balance: 7, asOfMs: 3_000 };
    expect(keepNewestBalance(prev, newer)).toEqual(newer);
  });

  it('takes the first snapshot', () => {
    expect(keepNewestBalance(undefined, prev)).toEqual(prev);
  });
});

describe('billingBalanceQueryOptions (#1881)', () => {
  it('rejects an older snapshot written to the cache', async () => {
    const queryClient = new QueryClient();
    const newer = { ...prev, balance: 7, asOfMs: 5_000 };
    await queryClient.ensureQueryData({
      ...billingBalanceQueryOptions,
      queryFn: () => Promise.resolve(newer),
    });

    queryClient.setQueryData([...BILLING_BALANCE_KEY], prev);

    expect(queryClient.getQueryData([...BILLING_BALANCE_KEY])).toBe(newer);
  });
});
