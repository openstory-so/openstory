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
import { billingChannelId, realtimeSchema } from '@/platform/realtime';
import type { BalanceUpdatedPayload } from '@/platform/realtime';
import { useRealtime } from '@/platform/ui/realtime/client';

export const BILLING_TRANSACTIONS_KEY = ['billing-transactions'] as const;

const balanceUpdatedSchema = realtimeSchema.billing['balance:updated'];

/**
 * Apply one event to the cached balance. `refetch` is true only when
 * nothing is cached yet. An event older than the cache is dropped by the
 * query's `keepNewestBalance`.
 */
export function applyBalanceEvent(
  prev: BillingBalanceData | undefined,
  event: BalanceUpdatedPayload
): { next: BillingBalanceData | undefined; refetch: boolean } {
  if (!prev) return { next: prev, refetch: true };
  const { balanceUsd, availableUsd, reservedUsd, asOfMs } = event;
  return {
    next: { ...prev, balance: balanceUsd, availableUsd, reservedUsd, asOfMs },
    refetch: false,
  };
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
