/**
 * Welcome Credits Dialog (#1096, #1516)
 *
 * - **claim**: Stripe on, $20 unpaid. Add a card (Stripe Checkout setup,
 *   no charge) to unlock it — or verify a mobile number by SMS when Twilio
 *   is configured (#1539; wallets like WeChat Pay cannot be saved as cards).
 * - **gift**: unused signup grant and Stripe off (e2e / self-host).
 *
 * Dismiss cadence lives in localStorage (house pattern for UI prefs).
 * Claim uses its own per-user key so a gift Skip cannot suppress it.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import {
  claimWelcomeCreditsFn,
  createSetupCheckoutSessionFn,
  sendWelcomePhoneCodeFn,
  verifyWelcomePhoneCodeFn,
} from '@/functions/billing';
import {
  BILLING_BALANCE_KEY,
  BILLING_PAYMENT_METHODS_KEY,
  useBillingBalance,
} from '@/hooks/use-billing-balance';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { useShowCosts } from '@/hooks/use-show-costs';
import { useUser } from '@/hooks/use-user';
import {
  SIGNUP_GRANT_MICROS,
  welcomeDialogMode,
} from '@/lib/billing/constants';
import type { WelcomeDialogMode } from '@/lib/billing/constants';
import { microsToDisplayUsd } from '@/lib/billing/money';
import { hasPendingGenerate } from '@/shared/generation/pending-generate';
import { isWelcomeCardAlreadyClaimedError } from '@/shared/errors';
import { phoneCountries } from '@/shared/phone-countries';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

const DISMISSED_AT_KEY = 'openstory:welcome-credits-dismissed-at';
const CLAIM_DISMISSED_AT_KEY = 'openstory:welcome-claim-dismissed-at';
const LEGACY_SEEN_KEY = 'openstory:welcome-credits-seen';

const RESHOW_INTERVAL_MS = 3 * 60 * 60 * 1000;

const GRANT_DISPLAY = microsToDisplayUsd(SIGNUP_GRANT_MICROS);

function parseDismissedAt(raw: string | null): number | null {
  if (!raw) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : null;
}

function readDismissedAt(
  mode: WelcomeDialogMode,
  userId: string
): number | null {
  try {
    if (mode === 'claim') {
      return parseDismissedAt(
        localStorage.getItem(`${CLAIM_DISMISSED_AT_KEY}:${userId}`)
      );
    }
    return (
      parseDismissedAt(localStorage.getItem(`${DISMISSED_AT_KEY}:${userId}`)) ??
      parseDismissedAt(localStorage.getItem(DISMISSED_AT_KEY))
    );
  } catch {
    return null;
  }
}

function isDismissInWindow(mode: WelcomeDialogMode, userId: string): boolean {
  const dismissedAt = readDismissedAt(mode, userId);
  return dismissedAt != null && Date.now() - dismissedAt < RESHOW_INTERVAL_MS;
}

function writeDismissedAt(mode: WelcomeDialogMode, userId: string): void {
  try {
    const now = String(Date.now());
    if (mode === 'claim') {
      localStorage.setItem(`${CLAIM_DISMISSED_AT_KEY}:${userId}`, now);
    } else {
      localStorage.setItem(`${DISMISSED_AT_KEY}:${userId}`, now);
      localStorage.setItem(DISMISSED_AT_KEY, now);
    }
    localStorage.removeItem(LEGACY_SEEN_KEY);
  } catch {
    // private mode / quota
  }
}

function clearDismissedAt(userId: string): void {
  try {
    localStorage.removeItem(`${CLAIM_DISMISSED_AT_KEY}:${userId}`);
    localStorage.removeItem(`${DISMISSED_AT_KEY}:${userId}`);
    localStorage.removeItem(DISMISSED_AT_KEY);
    localStorage.removeItem(LEGACY_SEEN_KEY);
  } catch {
    // private mode / quota
  }
}

function subscribeNever(): () => void {
  return () => {};
}

function claimErrorMessage(err: unknown): string {
  if (isWelcomeCardAlreadyClaimedError(err)) {
    return 'This card has already been used to claim welcome credits';
  }
  if (err instanceof Error) return err.message;
  return 'Could not unlock credits yet';
}

const WelcomeCreditsContext = createContext<{
  blocking: boolean;
  reopen: () => void;
} | null>(null);

export function useWelcomeCreditsGate(): {
  blocking: boolean;
  reopen: () => void;
} {
  return (
    useContext(WelcomeCreditsContext) ?? {
      blocking: false,
      reopen: () => {},
    }
  );
}

export const WelcomeCreditsProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { data: user } = useUser();
  const { showCosts, setShowCosts } = useShowCosts();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ from: '/_app/', shouldThrow: false });
  const welcomeSetup = search?.welcome_setup;
  const {
    stripeEnabled,
    phoneVerificationEnabled,
    phoneCountry,
    hasUsedCredits,
    hasSignupGrant,
    isSuccess: balanceReady,
    isError: balanceFailed,
  } = useBillingBalance();
  const [setupError, setSetupError] = useState<string | null>(null);
  const [skippedUserId, setSkippedUserId] = useState<string | null>(null);
  const [forcedOpen, setForcedOpen] = useState(false);
  const [redirectingToStripe, setRedirectingToStripe] = useState(false);
  const [viaPhone, setViaPhone] = useState(false);
  const isClient = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );

  const clearWelcomeSetupSearch = useCallback(() => {
    void navigate({
      to: '/',
      search: (prev) => ({
        style: prev.style,
        prefill: prev.prefill,
      }),
      replace: true,
    });
  }, [navigate]);

  const mode: WelcomeDialogMode = welcomeDialogMode({
    stripeEnabled,
    hasSignupGrant,
    hasUsedCredits,
  });

  const grantOff = SIGNUP_GRANT_MICROS <= 0;
  const recentlyDismissed = useSyncExternalStore(
    subscribeNever,
    () => Boolean(user && mode !== 'none' && isDismissInWindow(mode, user.id)),
    () => false
  );
  const balanceSettled = balanceReady || balanceFailed;
  const skipped = skippedUserId === user?.id;
  const returnedFromStripeSuccess = welcomeSetup === 'success';
  const open = Boolean(
    !grantOff &&
    isClient &&
    user &&
    balanceSettled &&
    !(stripeEnabled && hasSignupGrant) &&
    (forcedOpen ||
      returnedFromStripeSuccess ||
      (mode !== 'none' && !skipped && !recentlyDismissed))
  );
  const settled = !user || grantOff || (isClient && balanceSettled);

  const reopen = useCallback(() => {
    if (user) clearDismissedAt(user.id);
    setSkippedUserId(null);
    setForcedOpen(true);
    setSetupError(null);
  }, [user]);

  const handleOpenChange = (next: boolean) => {
    if (!next && redirectingToStripe) return;
    if (!next) {
      if (user) {
        writeDismissedAt(mode === 'none' ? 'claim' : mode, user.id);
        setSkippedUserId(user.id);
      }
      setForcedOpen(false);
      setSetupError(null);
      setViaPhone(false);
      if (welcomeSetup) clearWelcomeSetupSearch();
    }
  };

  useEffect(() => {
    if (welcomeSetup !== 'canceled') return;
    clearWelcomeSetupSearch();
  }, [welcomeSetup, clearWelcomeSetupSearch]);

  const setupMutation = useMutation({
    meta: { inlineError: true },
    mutationFn: () => createSetupCheckoutSessionFn(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (err) => {
      setRedirectingToStripe(false);
      setSetupError(
        err instanceof Error ? err.message : 'Could not open card setup'
      );
    },
  });

  const returnedFromStripe =
    returnedFromStripeSuccess &&
    !setupMutation.isPending &&
    !redirectingToStripe;

  const claimQuery = useQuery({
    queryKey: ['welcome-credits-claim', user?.id],
    queryFn: async () => {
      const result = await claimWelcomeCreditsFn();
      await queryClient.invalidateQueries({
        queryKey: [...BILLING_BALANCE_KEY],
      });
      await queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
      await queryClient.invalidateQueries({
        queryKey: [...BILLING_PAYMENT_METHODS_KEY],
      });
      if (result.granted || result.hasSignupGrant) {
        clearWelcomeSetupSearch();
        return result;
      }
      if (!result.hasCard) {
        throw new Error('Could not unlock credits yet');
      }
      throw new Error('Could not unlock credits');
    },
    enabled: Boolean(user && open && returnedFromStripe),
    retry: (count, err) => !isWelcomeCardAlreadyClaimedError(err) && count < 3,
    retryDelay: 1000,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  const value = useMemo(
    () => ({
      blocking:
        (!!user && !settled) ||
        (open && (mode === 'gift' || (mode === 'claim' && !hasSignupGrant))),
      reopen,
    }),
    [user, settled, open, mode, hasSignupGrant, reopen]
  );

  const primaryLabel = hasPendingGenerate()
    ? 'Keep creating'
    : 'Start creating';

  const claimError =
    setupError ??
    (claimQuery.error ? claimErrorMessage(claimQuery.error) : null);

  return (
    <WelcomeCreditsContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {/* One DialogContent for every branch: swapping the whole content
            would remount it and replay the open animation. */}
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
          {mode === 'gift' ? (
            <GiftDialogContent
              grantDisplay={GRANT_DISPLAY}
              showCosts={showCosts}
              onShowCostsChange={setShowCosts}
              onStart={() => handleOpenChange(false)}
              primaryLabel={primaryLabel}
            />
          ) : viaPhone ? (
            <PhoneClaimDialogContent
              grantDisplay={GRANT_DISPLAY}
              showCosts={showCosts}
              onShowCostsChange={setShowCosts}
              onGranted={async () => {
                await queryClient.invalidateQueries({
                  queryKey: [...BILLING_BALANCE_KEY],
                });
                await queryClient.invalidateQueries({
                  queryKey: [...BILLING_GATE_KEY],
                });
              }}
              onUseCard={() => setViaPhone(false)}
              defaultCountry={phoneCountry}
            />
          ) : (
            <ClaimDialogContent
              grantDisplay={GRANT_DISPLAY}
              showCosts={showCosts}
              onShowCostsChange={setShowCosts}
              setupError={claimError}
              opening={setupMutation.isPending || redirectingToStripe}
              claiming={claimQuery.isPending && returnedFromStripe}
              onAddCard={() => {
                setSetupError(null);
                setRedirectingToStripe(true);
                setupMutation.mutate();
              }}
              onSkip={() => handleOpenChange(false)}
              onUsePhone={
                phoneVerificationEnabled ? () => setViaPhone(true) : undefined
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </WelcomeCreditsContext.Provider>
  );
};

function ClaimDialogContent({
  grantDisplay,
  showCosts,
  onShowCostsChange,
  setupError,
  opening,
  claiming,
  onAddCard,
  onSkip,
  onUsePhone,
}: {
  grantDisplay: string;
  showCosts: boolean;
  onShowCostsChange: (value: boolean) => void;
  setupError: string | null;
  opening: boolean;
  claiming: boolean;
  onAddCard: () => void;
  onSkip: () => void;
  onUsePhone?: () => void;
}) {
  const busy = opening || claiming;
  return (
    <>
      <WelcomeHeader
        amount={grantDisplay}
        description="Add a card to unlock it. We won't charge you — it just confirms you're a real person."
      />

      <div className="flex flex-col gap-4 px-6 py-5">
        <Button className="self-center" onClick={onAddCard} disabled={busy}>
          {claiming ? 'Unlocking…' : opening ? 'Opening…' : 'Add a card'}
        </Button>

        {onUsePhone ? (
          <Button
            variant="link"
            className="self-center text-muted-foreground"
            onClick={onUsePhone}
            disabled={busy}
          >
            No card? Verify by SMS instead
          </Button>
        ) : null}

        {setupError ? (
          <p role="alert" className="text-xs text-destructive">
            {setupError}
          </p>
        ) : null}

        <ShowCostsRow checked={showCosts} onCheckedChange={onShowCostsChange} />

        <Button
          variant="link"
          className="self-end text-muted-foreground"
          onClick={onSkip}
          disabled={busy}
        >
          Skip for now
        </Button>
      </div>
    </>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** SMS branch of the claim dialog: number → code → grant. Closes itself via
 *  the balance refetch (`hasSignupGrant` flips, `open` goes false). */
function PhoneClaimDialogContent({
  grantDisplay,
  showCosts,
  onShowCostsChange,
  onGranted,
  onUseCard,
  defaultCountry,
}: {
  grantDisplay: string;
  showCosts: boolean;
  onShowCostsChange: (value: boolean) => void;
  onGranted: () => Promise<void>;
  onUseCard: () => void;
  defaultCountry: string | null;
}) {
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const countries = useMemo(() => phoneCountries(), []);

  const send = useMutation({
    meta: { inlineError: true },
    mutationFn: (data: { phoneNumber: string }) =>
      sendWelcomePhoneCodeFn({ data }),
    onSuccess: (result) => setPhoneNumber(result.phoneNumber),
  });
  const verify = useMutation({
    meta: { inlineError: true },
    mutationFn: (data: { phoneNumber: string; code: string }) =>
      verifyWelcomePhoneCodeFn({ data }),
    onSuccess: onGranted,
  });

  const busy = send.isPending || verify.isPending;
  const error = verify.error
    ? isWelcomeCardAlreadyClaimedError(verify.error)
      ? 'This number has already been used to claim welcome credits'
      : errorMessage(verify.error, 'Could not verify that code')
    : send.error
      ? errorMessage(send.error, 'Could not send a code')
      : null;

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' ? value : '';
    };
    if (phoneNumber) {
      verify.mutate({ phoneNumber, code });
      return;
    }
    send.mutate({ phoneNumber: field('phoneNumber') });
  };

  return (
    <>
      <WelcomeHeader
        amount={grantDisplay}
        description={
          phoneNumber
            ? `Enter the code we texted to ${phoneNumber}.`
            : "Verify your mobile number to unlock it. We only text you a code — it just confirms you're a real person."
        }
      />

      <form onSubmit={onSubmit} className="flex flex-col gap-4 px-6 py-5">
        {phoneNumber ? (
          // Plain field, not the slot widget: macOS/iOS autofill from Messages
          // needs a real, visible text input with one-time-code autocomplete.
          <Input
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            aria-label="Verification code"
            placeholder="6-digit code"
            className="text-center tracking-[0.3em] tabular-nums"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            disabled={busy}
            // oxlint-disable-next-line no-autofocus -- the code is the only field on this step
            autoFocus
          />
        ) : (
          <PhoneInput
            countries={countries}
            defaultCountry={defaultCountry}
            aria-label="Mobile number"
            disabled={busy}
            required
          />
        )}

        <Button
          type="submit"
          className="self-center"
          disabled={busy || (phoneNumber !== null && code.length !== 6)}
        >
          {phoneNumber
            ? verify.isPending
              ? 'Unlocking…'
              : 'Unlock'
            : send.isPending
              ? 'Sending…'
              : 'Send code'}
        </Button>

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <ShowCostsRow checked={showCosts} onCheckedChange={onShowCostsChange} />

        <div className="flex justify-between">
          {phoneNumber ? (
            <Button
              type="button"
              variant="link"
              className="text-muted-foreground"
              onClick={() => {
                setPhoneNumber(null);
                setCode('');
                verify.reset();
              }}
              disabled={busy}
            >
              Change number
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            variant="link"
            className="text-muted-foreground"
            onClick={onUseCard}
            disabled={busy}
          >
            Use a card instead
          </Button>
        </div>
      </form>
    </>
  );
}

function GiftDialogContent({
  grantDisplay,
  showCosts,
  onShowCostsChange,
  onStart,
  primaryLabel,
}: {
  grantDisplay: string;
  showCosts: boolean;
  onShowCostsChange: (value: boolean) => void;
  onStart: () => void;
  primaryLabel: string;
}) {
  return (
    <>
      <WelcomeHeader
        amount={grantDisplay}
        description="Free credits on us — enough for a typical 30s short with motion and music. Generations draw from this balance at provider rates."
      />

      <div className="flex flex-col gap-4 px-6 py-5">
        <ShowCostsRow checked={showCosts} onCheckedChange={onShowCostsChange} />

        <DialogFooter className="gap-2 sm:justify-stretch">
          <Button className="sm:flex-1" onClick={onStart}>
            {primaryLabel}
          </Button>
        </DialogFooter>
      </div>
    </>
  );
}

function WelcomeHeader({
  amount,
  description,
}: {
  amount: string;
  description: string;
}) {
  return (
    <div className="relative overflow-hidden border-b bg-gradient-to-br from-primary/20 via-primary/10 to-transparent px-6 pb-6 pt-8">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-10 size-40 rounded-full bg-primary/15 blur-2xl"
      />
      <div className="relative flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm ring-4 ring-primary/15">
          <Sparkles className="size-6" aria-hidden />
        </div>
        <p className="text-xs font-medium uppercase tracking-widest text-primary">
          Welcome gift
        </p>
        <DialogHeader className="items-center gap-1.5 sm:text-center">
          <DialogTitle className="font-heading text-3xl font-bold tracking-tight tabular-nums sm:text-4xl">
            {amount}
          </DialogTitle>
          <DialogDescription className="max-w-xs text-sm leading-relaxed">
            {description}
          </DialogDescription>
        </DialogHeader>
      </div>
    </div>
  );
}

function ShowCostsRow({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/[0.04] p-3.5">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Show costs</p>
        <p className="text-xs text-muted-foreground">
          Balance in the sidebar and estimates under Generate
        </p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label="Show costs"
      />
    </div>
  );
}
