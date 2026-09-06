import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { TYPICAL_SHORT_COST_USD } from '@/shared/billing/constants';
import {
  showLowBalanceToast,
  type LowBalanceToastProps,
} from './low-balance-toast';

/**
 * The hook only fires this on a real balance *decrease* across the threshold,
 * so the story calls it directly. Sonner needs a mounted <Toaster/> — the app
 * has one in Providers, the Storybook preview does not.
 */
function ToastHarness({
  balanceUsd,
  isZeroBalance,
  runCostUsd,
}: Omit<LowBalanceToastProps, 'onAddCredits' | 'onOtherOptions'>) {
  const show = useCallback(
    () =>
      showLowBalanceToast({
        balanceUsd,
        isZeroBalance,
        runCostUsd,
        onAddCredits: () => console.log('Add credits'),
        onOtherOptions: () => console.log('Other options'),
      }),
    [balanceUsd, isZeroBalance, runCostUsd]
  );

  useEffect(() => {
    show();
  }, [show]);

  return (
    <div className="flex min-h-40 items-start p-4">
      <Button variant="secondary" onClick={show}>
        Show toast again
      </Button>
      <Toaster />
    </div>
  );
}

const meta: Meta<typeof ToastHarness> = {
  title: 'Billing/LowBalanceToast',
  component: ToastHarness,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof ToastHarness>;

export const LowBalance: Story = {
  render: () => (
    <ToastHarness
      balanceUsd={4.21}
      isZeroBalance={false}
      runCostUsd={TYPICAL_SHORT_COST_USD}
    />
  ),
};

export const ZeroBalance: Story = {
  render: () => (
    <ToastHarness
      balanceUsd={0}
      isZeroBalance
      runCostUsd={TYPICAL_SHORT_COST_USD}
    />
  ),
};
