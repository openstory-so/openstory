/**
 * Billing Gate Dialog
 * Promotes credits first (#1096): buy credits, or ask the founder for some.
 * Gift codes and BYOK (Settings → API keys) are footer links.
 */

import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { AskFounderCard, founderOptionCardClassName } from './ask-founder-card';
import { useWelcomeCreditsGate } from './welcome-credits-dialog';
import { openAddCreditsDialog } from './use-add-credits-dialog';
import { useBillingBalance } from './use-billing-balance';
import { useBillingGateQuery } from './use-billing-gate';
import { shouldOfferWelcomeClaim } from '@/billing/constants';
import {
  closeBillingGate,
  getBillingGateReason,
  useBillingGateDialogOpen,
  type BillingGateReason,
} from './use-billing-gate-dialog';
import { cn } from '@/ui/utils';
import { usePostHog } from '@posthog/react';
import { Link } from '@tanstack/react-router';
import { ArrowRight, CreditCard, Gift, Key } from 'lucide-react';
import { useEffect } from 'react';

const RETURN_KEY = 'openstory:billing-return';

function setReturnPath(returnTo?: string) {
  const path =
    returnTo ??
    (typeof window !== 'undefined' ? window.location.pathname : '/');
  localStorage.setItem(RETURN_KEY, path);
}

type OptionCardProps = {
  to?: string;
  search?: Record<string, string>;
  icon: React.ReactNode;
  title: string;
  description: string;
  variant?: 'primary' | 'muted';
  onClick?: () => void;
};

const cardClassName = founderOptionCardClassName;

const OptionCard: React.FC<OptionCardProps> = ({
  to,
  search,
  icon,
  title,
  description,
  variant = 'muted',
  onClick,
}) => {
  const card = (
    <div className={cardClassName(variant)}>
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-200',
          variant === 'primary' && 'bg-primary text-primary-foreground',
          variant === 'muted' &&
            'bg-muted text-muted-foreground group-hover:bg-muted/80'
        )}
      >
        {icon}
      </div>
      <div className="flex-1 space-y-0.5">
        <span className="text-sm font-medium">{title}</span>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ArrowRight
        className={cn(
          'size-3.5 shrink-0 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-60',
          variant === 'primary' ? 'text-primary' : 'text-muted-foreground'
        )}
      />
    </div>
  );

  if (!to) {
    return (
      <button type="button" onClick={onClick} className="w-full text-left">
        {card}
      </button>
    );
  }

  return (
    <Link to={to} search={search} onClick={onClick}>
      {card}
    </Link>
  );
};

type BillingGateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasFalKey?: boolean;
  stripeEnabled?: boolean;
  returnTo?: string;
  context?: 'generation' | 'onboarding';
  /** `billing_gate_shown.reason` (#1301). */
  reason?: BillingGateReason;
};

export const BillingGateDialog: React.FC<BillingGateDialogProps> = ({
  open,
  onOpenChange,
  hasFalKey = false,
  stripeEnabled = true,
  returnTo,
  context = 'generation',
  reason = 'manual',
}) => {
  const posthog = usePostHog();

  useEffect(() => {
    if (open) posthog.capture('billing_gate_shown', { reason, context });
  }, [open, reason, context, posthog]);

  const handleNav = () => {
    setReturnPath(returnTo);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {context === 'onboarding'
              ? 'Get started with OpenStory'
              : 'Set up billing to continue'}
          </DialogTitle>
          <DialogDescription>
            {context === 'onboarding'
              ? 'Add credits or connect your own API key to start creating.'
              : 'This action uses AI credits. Add credits or connect your own key.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 pt-1">
          {stripeEnabled ? (
            <>
              {/* Opens the add-credits modal on top of the gate (#1099) */}
              <OptionCard
                icon={<CreditCard className="size-4" />}
                title="Add credits"
                description="Pay as you go. Auto-reload keeps you generating."
                variant="primary"
                onClick={() => openAddCreditsDialog('billing_gate')}
              />

              <AskFounderCard />
            </>
          ) : (
            <OptionCard
              to="/settings/api-keys"
              icon={<Key className="size-4" />}
              title="Use your own key"
              description="Connect fal.ai — images, video, audio, and script analysis."
              variant="primary"
              onClick={handleNav}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              to="/credits"
              search={{ tab: 'gift-codes' }}
              onClick={handleNav}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
            >
              <Gift className="size-3.5" />
              Redeem a gift code
            </Link>
            <Link
              to="/settings/api-keys"
              onClick={handleNav}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
            >
              <Key className="size-3.5" />
              Use your own key
            </Link>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground/70 hover:text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            {hasFalKey ? 'Continue' : 'Set up later'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Globally-mounted gate instance (#1099), opened via `openBillingGate()`.
 * If the welcome grant is still unpaid, openers get the claim dialog
 * instead of this gate (same as the low-balance toast). The onboarding
 * flow on the home composer keeps its own instance for its dismissal memory.
 */
export const GlobalBillingGateDialog: React.FC = () => {
  const open = useBillingGateDialogOpen();
  const { data } = useBillingGateQuery();
  const { stripeEnabled, hasSignupGrant, hasOtherCredits } =
    useBillingBalance();
  const { reopen } = useWelcomeCreditsGate();
  const offerClaim = shouldOfferWelcomeClaim({
    stripeEnabled,
    hasSignupGrant,
    hasOtherCredits,
  });

  useEffect(() => {
    if (!open || !offerClaim) return;
    closeBillingGate();
    reopen();
  }, [open, offerClaim, reopen]);

  return (
    <BillingGateDialog
      open={open && !offerClaim}
      onOpenChange={(next) => {
        if (!next) closeBillingGate();
      }}
      hasFalKey={data?.hasFalKey ?? false}
      stripeEnabled={data?.stripeEnabled ?? true}
      reason={open && !offerClaim ? getBillingGateReason() : undefined}
    />
  );
};
