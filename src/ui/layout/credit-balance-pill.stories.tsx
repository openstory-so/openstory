import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from '@/ui/shadcn/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarProvider,
} from '@/ui/shadcn/sidebar';
import {
  celebrateBalanceGain,
  useBalanceCountUp,
} from '@/billing/ui/use-balance-count-up';
import { BalancePillButton } from './credit-balance-pill';

/**
 * The welcome grant landing (#1668). In the app the claim dialog announces
 * the gain after the card is saved; here the button does.
 */
function GainHarness() {
  const [balance, setBalance] = useState(0);
  const { shown, gain } = useBalanceCountUp(balance);
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent />
        <SidebarFooter>
          <BalancePillButton
            amount={`$${balance.toFixed(2)}`}
            shown={shown}
            gain={gain}
            tooltip="Credits"
            toneClass={
              gain !== null
                ? 'text-emerald-600 dark:text-emerald-400'
                : undefined
            }
          />
        </SidebarFooter>
      </Sidebar>
      <div className="p-4">
        <Button
          variant="secondary"
          onClick={() => {
            setBalance((b) => b + 20);
            celebrateBalanceGain(20);
          }}
        >
          Claim $20
        </Button>
      </div>
    </SidebarProvider>
  );
}

const meta: Meta<typeof GainHarness> = {
  title: 'Layout/CreditBalancePill',
  component: GainHarness,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof GainHarness>;

export const WelcomeGrantLands: Story = {};
