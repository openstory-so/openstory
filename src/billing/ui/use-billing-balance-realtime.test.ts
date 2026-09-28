import { describe, expect, it } from 'vitest';
import { applyBalanceEvent } from './use-billing-balance-realtime';

type Prev = NonNullable<Parameters<typeof applyBalanceEvent>[0]>;

const prev: Prev = {
  teamId: 'team_1',
  balance: 10,
  availableUsd: 8,
  reservedUsd: 2,
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
  amountUsd: -1,
  transactionId: 'tx_1',
  type: 'credit_usage' as const,
};

describe('applyBalanceEvent (#1881)', () => {
  it('settles a full usage event without a refetch', () => {
    const { next, refetch } = applyBalanceEvent(prev, usage);
    expect(refetch).toBe(false);
    expect(next).toMatchObject({ balance: 9, availableUsd: 7, reservedUsd: 2 });
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

  it('refetches when the hold fields are missing', () => {
    const { availableUsd: _, reservedUsd: __, ...old } = usage;
    expect(applyBalanceEvent(prev, old).refetch).toBe(true);
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
