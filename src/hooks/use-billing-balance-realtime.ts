/**
 * Live credit-balance updates over SSE (#1090).
 *
 * Subscribes to `billing:${teamId}` only while the credit pill is visible so
 * idle sessions pay no realtime cost. On `billing.balance:updated`, optimistically
 * patches the balance query and invalidates transactions for the ledger tab.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { billingChannelId } from '@/lib/realtime';
import { useRealtime } from '@/lib/realtime/client';

export const BILLING_TRANSACTIONS_KEY = ['billing-transactions'] as const;

type BalanceQueryData = {
  teamId?: string;
  balance: number;
  availableUsd?: number;
  reservedUsd?: number;
  stripeEnabled: boolean;
  autoTopUp: {
    enabled: boolean;
    thresholdUsd: number | null;
    amountUsd: number | null;
    lastFailure: { at: string } | null;
  };
  hasPaymentMethod: boolean;
};

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
      data: {
        teamId: string;
        balanceUsd: number;
        availableUsd?: number;
        reservedUsd?: number;
        amountUsd: number;
        transactionId?: string;
        type?:
          | 'credit_purchase'
          | 'credit_usage'
          | 'credit_refund'
          | 'credit_adjustment';
      };
    }) => {
      const { balanceUsd, availableUsd, reservedUsd } = msg.data;

      queryClient.setQueryData<BalanceQueryData>(
        [...BILLING_BALANCE_KEY],
        (prev) =>
          prev
            ? {
                ...prev,
                balance: balanceUsd,
                availableUsd: availableUsd ?? prev.availableUsd,
                reservedUsd: reservedUsd ?? prev.reservedUsd,
              }
            : prev
      );

      void queryClient.invalidateQueries({
        queryKey: [...BILLING_BALANCE_KEY],
      });
      void queryClient.invalidateQueries({
        queryKey: [...BILLING_TRANSACTIONS_KEY],
      });
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
