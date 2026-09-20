import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Button } from '@/ui/shadcn/button';
import { Dialog, DialogContent } from '@/ui/shadcn/dialog';
import { ClaimDialogContent } from './welcome-credits-dialog';

/**
 * The provider decides when to open from the balance, the user and the URL, so
 * the story renders the claim content directly. Reopen to replay the confetti.
 */
function ClaimHarness({ claiming }: { claiming: boolean }) {
  const [open, setOpen] = useState(true);
  const [showCosts, setShowCosts] = useState(true);
  return (
    <div className="flex min-h-40 items-start p-4">
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open again
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          <ClaimDialogContent
            grantDisplay="$20.00"
            showCosts={showCosts}
            onShowCostsChange={setShowCosts}
            setupError={null}
            opening={false}
            claiming={claiming}
            onAddCard={() => console.log('Add a card')}
            onBuyCredits={() => console.log('Buy credits')}
            onSkip={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

const meta: Meta<typeof ClaimHarness> = {
  title: 'Billing/WelcomeCreditsDialog',
  component: ClaimHarness,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof ClaimHarness>;

export const Claim: Story = { args: { claiming: false } };

export const Unlocking: Story = { args: { claiming: true } };
