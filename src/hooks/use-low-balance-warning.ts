import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { openAddCreditsDialog } from './use-add-credits-dialog';
import { openBillingGate } from './use-billing-gate-dialog';
import { useBillingBalance } from './use-billing-balance';

export function useLowBalanceWarning() {
  const { balance, isLowBalance, isZeroBalance, lowBalanceThreshold } =
    useBillingBalance();
  const prevBalanceRef = useRef<number | null>(null);
  const hasWarnedRef = useRef(false);

  useEffect(() => {
    if (balance === null) return;

    const prevBalance = prevBalanceRef.current;
    prevBalanceRef.current = balance;

    if (prevBalance === null) return;

    if (balance >= prevBalance) {
      if (balance > lowBalanceThreshold) {
        hasWarnedRef.current = false;
      }
      return;
    }

    if (hasWarnedRef.current) return;

    if (isZeroBalance) {
      hasWarnedRef.current = true;
      toast.error('Balance is $0', {
        description: 'Generation is off until you add credits.',
        action: {
          label: 'Add $10',
          onClick: () => openAddCreditsDialog(),
        },
        cancel: {
          label: 'Other options',
          onClick: () => openBillingGate(),
        },
        duration: 10_000,
      });
    } else if (isLowBalance) {
      hasWarnedRef.current = true;
      toast.warning(`Balance is $${balance.toFixed(2)}`, {
        description: 'Another short is about $13.',
        action: {
          label: 'Add $10',
          onClick: () => openAddCreditsDialog(),
        },
        duration: 8_000,
      });
    }
  }, [balance, isLowBalance, isZeroBalance, lowBalanceThreshold]);
}
