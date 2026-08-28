/**
 * Shared billing balance hook
 * Provides balance data, low-balance detection, and query key for invalidation
 */

import { useQuery } from '@tanstack/react-query';
import { useAuthSession } from '@/lib/auth/session-query';
import { LOW_BALANCE_THRESHOLD_USD } from '@/lib/billing/constants';
import { getBillingBalanceFn } from '@/functions/billing';

export const BILLING_BALANCE_KEY = ['billing-balance'] as const;

export function useBillingBalance() {
  const { data: session } = useAuthSession();

  const query = useQuery({
    queryKey: [...BILLING_BALANCE_KEY],
    queryFn: () => getBillingBalanceFn(),
    staleTime: 30_000,
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
    hasUsedCredits: query.data?.hasUsedCredits ?? false,
    isLowBalance:
      balance !== null && balance > 0 && balance <= lowBalanceThreshold,
    isZeroBalance: balance !== null && balance <= 0,
    lowBalanceThreshold,
  };
}
