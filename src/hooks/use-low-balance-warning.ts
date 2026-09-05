/**
 * Low Balance Warning Hook
 * Fires toast notifications when balance decreases and crosses threshold,
 * and when a generation is rejected for insufficient credits (preflight
 * does not debit, so that path never looks like a balance drop).
 */

import { usePostHog } from '@posthog/react';
import { useCallback, useEffect, useRef } from 'react';
import { showLowBalanceToast } from '@/components/billing/low-balance-toast';
import { subscribeInsufficientCredits } from './notify-insufficient-credits';
import { openAddCreditsDialog } from './use-add-credits-dialog';
import { openBillingGate } from './use-billing-gate-dialog';
import { useBillingBalance } from './use-billing-balance';
import { useFalPricing } from './use-fal-pricing';
import { typicalShortCostUsd } from '@/shared/billing/typical-short-cost';

export function useLowBalanceWarning() {
  const { balance, isLowBalance, isZeroBalance, lowBalanceThreshold } =
    useBillingBalance();
  const { pricing } = useFalPricing();
  const posthog = usePostHog();
  const prevBalanceRef = useRef<number | null>(null);
  const hasWarnedRef = useRef(false);

  const fireToast = useCallback(
    (source: 'balance_drop' | 'insufficient_credits') => {
      const balanceUsd = balance ?? 0;
      const zero = balance === null ? true : isZeroBalance;
      const props = {
        balance_usd: balanceUsd,
        is_zero: zero,
        source,
      };
      posthog.capture('low_balance_toast_shown', props);

      const clicked = (choice: 'add_credits' | 'other_options') =>
        posthog.capture('low_balance_toast_clicked', { ...props, choice });

      showLowBalanceToast({
        balanceUsd,
        isZeroBalance: zero,
        runCostUsd: typicalShortCostUsd(pricing),
        onAddCredits: () => {
          clicked('add_credits');
          openAddCreditsDialog('low_balance_toast');
        },
        onOtherOptions: () => {
          clicked('other_options');
          openBillingGate(zero ? 'zero' : 'insufficient');
        },
      });
    },
    [balance, isZeroBalance, posthog, pricing]
  );

  useEffect(() => {
    return subscribeInsufficientCredits(() => {
      fireToast('insufficient_credits');
    });
  }, [fireToast]);

  useEffect(() => {
    if (balance === null) return;

    const prevBalance = prevBalanceRef.current;
    prevBalanceRef.current = balance;

    // Only warn on balance decrease, not on initial load
    if (prevBalance === null) return;
    if (balance >= prevBalance) {
      // Balance went up — reset warning so it can fire again next time
      if (balance > lowBalanceThreshold) {
        hasWarnedRef.current = false;
      }
      return;
    }

    // Balance decreased — check if we should warn
    if (hasWarnedRef.current) return;
    if (!isZeroBalance && !isLowBalance) return;

    hasWarnedRef.current = true;
    fireToast('balance_drop');
  }, [balance, fireToast, isLowBalance, isZeroBalance, lowBalanceThreshold]);
}
