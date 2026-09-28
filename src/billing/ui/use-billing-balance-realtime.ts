/**
 * Live credit-balance updates over SSE (#1090).
 *
 * Subscribes to `billing:${teamId}` only while the credit pill is visible so
 * idle sessions pay no realtime cost. On `billing.balance:updated`, patches the
 * balance query from the event and invalidates transactions for the ledger
 * tab. The balance itself is refetched only when the event cannot settle it
 * (#1881) — a generation emits several a second.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { BILLING_BALANCE_KEY } from './use-billing-balance';
import type { BillingBalanceData } from './use-billing-balance';
import { hasOtherCredits } from '@/billing/constants';
import { usdToMicros } from '@/billing/money';
import { billingChannelId, realtimeSchema } from '@/platform/realtime';
import type { BalanceUpdatedPayload } from '@/platform/realtime';
import { useRealtime } from '@/platform/ui/realtime/client';

export const BILLING_TRANSACTIONS_KEY = ['billing-transactions'] as const;

const balanceUpdatedSchema = realtimeSchema.billing['balance:updated'];

/**
 * Apply one event to the cached balance. `refetch` is true when the event
 * leaves something unknown: a purchase / refund / adjustment (may change
 * `hasSignupGrant`), or a team whose first usage may have been coalesced
 * away before it arrived. An event older than the cache is dropped by the
 * query's `keepNewestBalance`.
 */
export function applyBalanceEvent(
  prev: BillingBalanceData | undefined,
  event: BalanceUpdatedPayload
): { next: BillingBalanceData | undefined; refetch: boolean } {
  if (!prev) return { next: prev, refetch: true };
  const { balanceUsd, availableUsd, reservedUsd, asOfMs, type } = event;
  const next: BillingBalanceData = {
    ...prev,
    balance: balanceUsd,
    availableUsd,
    reservedUsd,
    asOfMs,
    hasUsedCredits: prev.hasUsedCredits || type === 'credit_usage',
    hasOtherCredits: hasOtherCredits(
      usdToMicros(balanceUsd),
      prev.hasSignupGrant
    ),
  };
  const refetch =
    (type !== undefined && type !== 'credit_usage') || !next.hasUsedCredits;
  return { next, refetch };
}

/**
 * @param teamId - Active team; subscription is a no-op while undefined
 * @param enabled - True only while the credit pill is on-screen
 */
export function useBillingBalanceRealtime(
  teamId: string | undefined,
  enabled: boolean
) {
  const queryClient = useQueryClient();

  const onData = useCallback(
    (msg: {
      event: 'billing.balance:updated';
      data: BalanceUpdatedPayload;
    }) => {
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_TRANSACTIONS_KEY],
      });
      // The transport only JSON-parses. An event from a worker on the other
      // side of a deploy can lack `asOfMs`; refetch rather than patch.
      const event = balanceUpdatedSchema.safeParse(msg.data);
      if (!event.success) {
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
        return;
      }
      const { next, refetch } = applyBalanceEvent(
        queryClient.getQueryData<BillingBalanceData>([...BILLING_BALANCE_KEY]),
        event.data
      );
      if (next) {
        queryClient.setQueryData<BillingBalanceData>(
          [...BILLING_BALANCE_KEY],
          next
        );
      }

      if (refetch) {
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
      }
    },
    [queryClient]
  );

  useRealtime({
    channels: teamId ? [billingChannelId(teamId)] : [],
    events: ['billing.balance:updated'] as const,
    enabled: Boolean(enabled && teamId),
    onData,
  });
}
