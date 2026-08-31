/**
 * Add Credits Dialog (#1099)
 * OpenAI-style "Add to credit balance" modal — the in-app purchase surface.
 * (Credits also arrive via gift codes, the signup grant, founder grants, and
 * auto-top-up.) A saved card is charged in place; "+ Add payment method" (or
 * having no saved card) falls back to Stripe Checkout, which saves the card
 * for next time. Globally mounted in AppLayout, opened via
 * openAddCreditsDialog().
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  createCheckoutSessionFn,
  listPaymentMethodsFn,
  purchaseCreditsFn,
} from '@/functions/billing';
import {
  prepareBalanceFlash,
  triggerBalanceFlash,
} from '@/hooks/use-balance-flash';
import {
  closeAddCreditsDialog,
  getAddCreditsSurface,
  useAddCreditsDialogOpen,
} from '@/hooks/use-add-credits-dialog';
import { closeBillingGate } from '@/hooks/use-billing-gate-dialog';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { useAuthSession } from '@/lib/auth/session-query';
import {
  formatPlatformFeePercent,
  MAX_TOPUP_AMOUNT_USD,
  MIN_TOPUP_AMOUNT_USD,
  splitCheckoutAmounts,
} from '@/lib/billing/constants';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CreditCard, ExternalLink, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ulid } from 'ulid';

/** Sentinel Select value for "pay with a new card at checkout". */
const NEW_CARD = 'new-card';

function formatBrand(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1);
}

export function AddCreditsDialog() {
  const open = useAddCreditsDialogOpen();
  const { data: session } = useAuthSession();
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  // Every "Add credits" button routes through openAddCreditsDialog(surface),
  // so one capture here covers them all (#1301).
  useEffect(() => {
    if (open) {
      posthog.capture('add_credits_clicked', {
        surface: getAddCreditsSurface(),
      });
    }
  }, [open, posthog]);

  const [amount, setAmount] = useState('10');
  const [selectedPm, setSelectedPm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Idempotency key for the purchase. Stable across retries of the same
   * attempt (React Query resends the same variables), so a timed-out request
   * whose charge actually landed can never charge or credit a second time.
   */
  const [requestId, setRequestId] = useState(() => ulid());

  const {
    data: pmData,
    isLoading: pmLoading,
    error: pmError,
  } = useQuery({
    queryKey: ['billing-payment-methods'],
    queryFn: () => listPaymentMethodsFn(),
    staleTime: 60_000,
    enabled: open && !!session,
  });

  // Sorted default-first by listPaymentMethodsFn, so [0] is the default card.
  const paymentMethods = pmData?.paymentMethods ?? [];
  const effectivePm = selectedPm ?? paymentMethods[0]?.id ?? NEW_CARD;

  const amountUsd = parseFloat(amount);
  const isValidAmount =
    !isNaN(amountUsd) &&
    amountUsd >= MIN_TOPUP_AMOUNT_USD &&
    amountUsd <= MAX_TOPUP_AMOUNT_USD;
  const breakdown = isValidAmount ? splitCheckoutAmounts(amountUsd) : null;

  const onOpenChange = (next: boolean) => {
    if (!next) {
      setError(null);
      closeAddCreditsDialog();
    }
  };

  const invalidateBilling = () => {
    void queryClient.invalidateQueries({ queryKey: [...BILLING_BALANCE_KEY] });
    void queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
    void queryClient.invalidateQueries({ queryKey: ['billing-invoices'] });
  };

  const purchaseMutation = useMutation({
    meta: { inlineError: true },
    mutationFn: (input: {
      amountUsd: number;
      paymentMethodId: string;
      requestId: string;
    }) => purchaseCreditsFn({ data: input }),
    onSuccess: (_data, input) => {
      invalidateBilling();
      triggerBalanceFlash();
      toast.success(
        `Added $${input.amountUsd.toFixed(2)} to your credit balance`
      );
      onOpenChange(false);
      // This dialog often opens on top of the gate; with credits now bought,
      // leaving the gate up (it blocks Escape and outside-click) would strand
      // the user on a "you're out of credits" modal they just resolved.
      closeBillingGate();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Payment failed');
      // A new key on retry: the failed attempt's key is spent, and Stripe
      // replays the original outcome for a reused one.
      setRequestId(ulid());
    },
  });

  const checkoutMutation = useMutation({
    meta: { inlineError: true },
    mutationFn: (checkoutAmountUsd: number) =>
      createCheckoutSessionFn({ data: { amountUsd: checkoutAmountUsd } }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    },
  });

  const isPending = purchaseMutation.isPending || checkoutMutation.isPending;

  const handleContinue = () => {
    if (!isValidAmount) {
      setError(
        `Enter an amount between $${MIN_TOPUP_AMOUNT_USD} and $${MAX_TOPUP_AMOUNT_USD.toLocaleString()}`
      );
      return;
    }
    setError(null);
    const method = effectivePm === NEW_CARD ? 'checkout' : 'saved_card';
    posthog.capture('credits_topup_started', {
      amount_usd: amountUsd,
      method,
    });
    if (method === 'checkout') {
      try {
        // Suggest this amount for auto-top-up on return from Stripe
        localStorage.setItem('openstory:last-topup-amount', String(amountUsd));
      } catch {
        // Private mode / quota. This only seeds a follow-up prompt — it must
        // never stop the checkout the user actually asked for.
      }
      prepareBalanceFlash();
      checkoutMutation.mutate(amountUsd);
      return;
    }
    purchaseMutation.mutate({
      amountUsd,
      paymentMethodId: effectivePm,
      requestId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add to credit balance</DialogTitle>
          <DialogDescription className="sr-only">
            Buy credits with a saved card or at checkout.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="add-credits-amount">Amount to add</Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              $
            </span>
            <Input
              id="add-credits-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value.replace(/[^0-9.]/g, ''));
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleContinue();
              }}
              className="pl-7 tabular-nums"
              autoComplete="off"
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              Enter an amount between ${MIN_TOPUP_AMOUNT_USD} and $
              {MAX_TOPUP_AMOUNT_USD.toLocaleString()}
            </span>
            <Link
              to="/pricing"
              onClick={() => onOpenChange(false)}
              className="inline-flex shrink-0 items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
            >
              Pricing
              <ExternalLink className="size-3" />
            </Link>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="add-credits-payment-method">Payment method</Label>
          {pmError ? (
            // Never render a failed fetch as "you have no saved cards" — that
            // silently pushes a returning customer back through Checkout.
            <p role="alert" className="text-xs text-destructive">
              Couldn&apos;t load your saved cards
              {pmError instanceof Error && <span>: {pmError.message}</span>}
            </p>
          ) : pmLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <Select
              value={effectivePm}
              items={[
                ...paymentMethods.map((pm) => ({
                  value: pm.id,
                  label: `${formatBrand(pm.brand)} •••• ${pm.last4}`,
                })),
                { value: NEW_CARD, label: 'New card at checkout' },
              ]}
              onValueChange={(value) => {
                if (value == null) return;
                setSelectedPm(value);
                setError(null);
              }}
            >
              <SelectTrigger id="add-credits-payment-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {paymentMethods.map((pm) => (
                  <SelectItem key={pm.id} value={pm.id}>
                    <CreditCard className="size-4 text-muted-foreground" />
                    {formatBrand(pm.brand)} •••• {pm.last4}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CARD}>
                  <Plus className="size-4 text-muted-foreground" />
                  New card at checkout
                </SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => {
                setSelectedPm(NEW_CARD);
                setError(null);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="size-3" />
              Add payment method
            </button>
          </div>
        </div>

        {breakdown && (
          <p className="text-xs text-muted-foreground tabular-nums">
            You&apos;ll be charged ${breakdown.totalUsd.toFixed(2)} — includes
            the {formatPlatformFeePercent()} platform fee.
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          {/* pmLoading gates submit: until the cards land, effectivePm is
              NEW_CARD, so an early click would bounce a saved-card customer
              out to Checkout. */}
          <Button
            onClick={handleContinue}
            disabled={!isValidAmount || isPending || pmLoading}
          >
            {isPending ? 'Processing…' : 'Continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
