/**
 * Low Balance Warning Hook
 * Fires toast notifications when balance decreases and crosses threshold
 */

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { openAddCreditsDialog } from './use-add-credits-dialog';
import { openBillingGate } from './use-billing-gate-dialog';
import { useBillingBalance } from './use-billing-balance';

export function useLowBalanceWarning() {
  const {
    balance,
    isLowBalance,
    isZeroBalance,
    lowBalanceThreshold,
    lastFailure,
  } = useBillingBalance();
  const prevBalanceRef = useRef<number | null>(null);
  const hasWarnedRef = useRef(false);
  const lastFailureToastKeyRef = useRef<string | null>(null);

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

    // "Options" opens the billing gate — buying credits, asking the founder,
    // fal.ai BYOK, and gift codes all live there (#1099).
    if (isZeroBalance) {
      hasWarnedRef.current = true;
      toast.error('Your credit balance is $0', {
        description: 'Generation is disabled until you add credits.',
        action: {
          label: 'Options',
          onClick: openBillingGate,
        },
        duration: 10_000,
      });
    } else if (isLowBalance) {
      hasWarnedRef.current = true;
      toast.warning(`Balance is below $${lowBalanceThreshold}`, {
        description: `Your balance is $${balance.toFixed(2)}.`,
        action: {
          label: 'Options',
          onClick: openBillingGate,
        },
        duration: 8_000,
      });
    }
  }, [balance, isLowBalance, isZeroBalance, lowBalanceThreshold]);

  useEffect(() => {
    if (!lastFailure) {
      lastFailureToastKeyRef.current = null;
      return;
    }
    if (lastFailureToastKeyRef.current === lastFailure.at) return;
    lastFailureToastKeyRef.current = lastFailure.at;
    toast.error('Auto top-up failed — update your card', {
      description:
        'We paused auto-reload after your card was declined. Update your payment method to resume.',
      action: {
        label: 'Update card',
        onClick: openAddCreditsDialog,
      },
      duration: 10_000,
    });
  }, [lastFailure]);
}
