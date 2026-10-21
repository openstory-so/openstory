/**
 * Shared billing balance hook
 * Provides balance data, low-balance detection, and query key for invalidation
 */

import {
  queryOptions,
  replaceEqualDeep,
  useQuery,
} from '@tanstack/react-query';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import { LOW_BALANCE_THRESHOLD_USD } from '@/billing/constants';
import { getBillingBalanceFn } from '@/billing/billing.fn';

export const BILLING_BALANCE_KEY = ['billing-balance'] as const;
export const BILLING_PAYMENT_METHODS_KEY = ['billing-payment-methods'] as const;

export type BillingBalanceData = Awaited<
  ReturnType<typeof getBillingBalanceFn>
>;

/**
 * Keep the newer snapshot. Realtime patches and refetches both write this
 * query, and either can land after a newer one: a fetch that started before
 * an event, or two events from concurrent debits arriving out of order
 * (#1881). Snapshots taken in the same millisecond may still swap.
 */
export function keepNewestBalance(prev: unknown, next: unknown): unknown {
  if (asOfMs(prev) > asOfMs(next)) return prev;
  return replaceEqualDeep(prev, next);
}

/** Query-core types structural sharing as `unknown`. */
function asOfMs(data: unknown): number {
  return typeof data === 'object' &&
    data !== null &&
    'asOfMs' in data &&
    typeof data.asOfMs === 'number'
    ? data.asOfMs
    : -Infinity;
}

/** Seeded in the app shell's beforeLoad so the credit pill paints on
 *  first render instead of after a client fetch. */
export const billingBalanceQueryOptions = queryOptions({
  queryKey: [...BILLING_BALANCE_KEY],
  queryFn: () => getBillingBalanceFn(),
  staleTime: 30_000,
  // Every write goes through this, `setQueryData` included.
  structuralSharing: keepNewestBalance,
});

export function useBillingBalance() {
  const { data: session } = useAuthSession();

  const query = useQuery({
    ...billingBalanceQueryOptions,
    enabled: !!session?.user,
  });

  const posted = query.data?.balance ?? null;
  const balance = query.data?.availableUsd ?? posted;
  const reserved = query.data?.reservedUsd ?? 0;
  const autoTopUp = query.data?.autoTopUp;
  const lowBalanceThreshold =
    autoTopUp?.enabled && autoTopUp.thresholdUsd != null
      ? autoTopUp.thresholdUsd
      : LOW_BALANCE_THRESHOLD_USD;

  return {
    ...query,
    balance,
    posted,
    reserved,
    teamId: query.data?.teamId,
    stripeEnabled: query.data?.stripeEnabled ?? false,
    isLowBalance:
      balance !== null && balance > 0 && balance <= lowBalanceThreshold,
    isZeroBalance: balance !== null && balance <= 0,
    lowBalanceThreshold,
  };
}
