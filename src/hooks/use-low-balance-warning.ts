/**
 * Low Balance Warning Hook
 * Fires toast notifications when balance decreases and crosses threshold
 */

import { usePostHog } from '@posthog/react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { openBillingGate } from './use-billing-gate-dialog';
import { useBillingBalance } from './use-billing-balance';

export function useLowBalanceWarning() {
  const { balance, isLowBalance, isZeroBalance, lowBalanceThreshold } =
    useBillingBalance();
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

    // "Options" opens the billing gate — buying credits, asking the founder,
    // fal.ai BYOK, and gift codes all live there (#1099).
    hasWarnedRef.current = true;
    const props = { balance_usd: balance };
    posthog.capture('low_balance_toast_shown', props);
    const action = {
      label: 'Options',
      onClick: () => {
        posthog.capture('low_balance_toast_clicked', props);
        openBillingGate(isZeroBalance ? 'zero' : 'manual');
      },
    };
    if (isZeroBalance) {
      toast.error('Your credit balance is $0', {
        description: 'Generation is disabled until you add credits.',
        action,
        duration: 10_000,
      });
    } else {
      toast.warning(`Balance is below $${lowBalanceThreshold}`, {
        description: `Your balance is $${balance.toFixed(2)}.`,
        action,
        duration: 8_000,
      });
    }
  }, [balance, isLowBalance, isZeroBalance, lowBalanceThreshold, posthog]);
}
