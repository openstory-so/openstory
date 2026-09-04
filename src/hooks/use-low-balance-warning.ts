/**
 * Low Balance Warning Hook
 * Fires toast notifications when balance decreases and crosses threshold
 */

import { usePostHog } from '@posthog/react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { openAddCreditsDialog } from './use-add-credits-dialog';
import { openBillingGate } from './use-billing-gate-dialog';
import { useBillingBalance } from './use-billing-balance';
import { useFalPricing } from './use-fal-pricing';
import { MIN_TOPUP_AMOUNT_USD } from '@/lib/billing/constants';
import { typicalShortCostUsd } from '@/lib/billing/typical-short-cost';

export function useLowBalanceWarning() {
  const { balance, isLowBalance, isZeroBalance, lowBalanceThreshold } =
    useBillingBalance();
  const { pricing } = useFalPricing();
  const posthog = usePostHog();
  const prevBalanceRef = useRef<number | null>(null);
  const hasWarnedRef = useRef(false);

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
    const props = { balance_usd: balance, is_zero: isZeroBalance };
    posthog.capture('low_balance_toast_shown', props);

    // The offer itself is the primary action (#1299) — the toast was the most
    // reacted-to billing moment and sent people to pricing to find it. The
    // gate (BYOK, gift codes, founder credits) stays one tap away.
    const action = {
      label: `Add $${MIN_TOPUP_AMOUNT_USD}`,
      onClick: () => {
        posthog.capture('low_balance_toast_clicked', {
          ...props,
          choice: 'add_credits',
        });
        openAddCreditsDialog('low_balance_toast');
      },
    };
    const cancel = {
      label: 'Other options',
      onClick: () => {
        posthog.capture('low_balance_toast_clicked', {
          ...props,
          choice: 'other_options',
        });
        openBillingGate(isZeroBalance ? 'zero' : 'manual');
      },
    };

    if (isZeroBalance) {
      toast.error('Your credit balance is $0', {
        description: 'Generation is off until you add credits.',
        action,
        cancel,
        duration: 10_000,
      });
    } else {
      toast.warning(`Balance is $${balance.toFixed(2)}`, {
        description: `Another short is about $${Math.round(typicalShortCostUsd(pricing))}.`,
        action,
        cancel,
        duration: 8_000,
      });
    }
  }, [
    balance,
    isLowBalance,
    isZeroBalance,
    lowBalanceThreshold,
    posthog,
    pricing,
  ]);
}
