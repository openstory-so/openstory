/**
 * Billing Gate Dialog
 * Promotes credits first (#1096): buy credits, or ask the founder for some,
 * with BYOK below — a fal.ai key alone covers everything, since LLM calls
 * route through fal's OpenRouter endpoint. Gift codes at the bottom.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { FalLogo } from '@/components/icons/fal-logo';
import { saveApiKeyFn } from '@/functions/api-keys';
import { requestFounderCreditsFn } from '@/functions/billing';
import { getCurrentUserProfileFn } from '@/functions/user';
import { openAddCreditsDialog } from '@/hooks/use-add-credits-dialog';
import {
  BILLING_GATE_KEY,
  useBillingGateQuery,
} from '@/hooks/use-billing-gate';
import {
  closeBillingGate,
  getBillingGateReason,
  useBillingGateDialogOpen,
  type BillingGateReason,
} from '@/hooks/use-billing-gate-dialog';
import { cn } from '@/lib/utils';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Check,
  CreditCard,
  ExternalLink,
  Gift,
  HeartHandshake,
} from 'lucide-react';
import { useEffect, useState } from 'react';

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

const cardClassName = (variant: 'primary' | 'muted') =>
  cn(
    'group relative flex items-center gap-3.5 rounded-xl border p-3.5 transition-all duration-200',
    // The primary card is THE action — it must read as highlighted next to
    // the muted fallbacks, not as a sibling (#1099).
    variant === 'primary' &&
      'border-primary/50 bg-primary/10 hover:border-primary hover:bg-primary/15',
    variant === 'muted' &&
      'border-border/60 bg-transparent hover:border-border hover:bg-accent/50'
  );

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

/**
 * "Ask the founder for credits" (#1096, reworked in #1099) — expands into an
 * optional message form (like the Feedback dialog) before emailing the
 * founder (a PostHog product event fires server-side). Success collapses
 * into a confirmation card so it can't be re-sent from the same dialog.
 */
const AskFounderCard: React.FC = () => {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      requestFounderCreditsFn({
        data: { message: message.trim() || undefined },
      }),
  });

  if (mutation.isSuccess) {
    return (
      <div className={cardClassName('muted')}>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-emerald-600 dark:text-emerald-400">
          <Check className="size-4" />
        </div>
        <div className="flex-1 space-y-0.5">
          <span className="text-sm font-medium">Request sent</span>
          <p className="text-xs text-muted-foreground">
            Tom will reply to your account email soon.
          </p>
        </div>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={cn(cardClassName('muted'), 'w-full text-left')}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover:bg-muted/80">
          <HeartHandshake className="size-4" />
        </div>
        <div className="flex-1 space-y-0.5">
          <span className="text-sm font-medium">
            Ask the founder for credits
          </span>
          <p className="text-xs text-muted-foreground">
            Seriously. Tom replies.
          </p>
        </div>
        <ArrowRight className="size-3.5 shrink-0 -translate-x-1 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-60" />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 p-3.5">
      <div className="flex items-center gap-3.5">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <HeartHandshake className="size-4" />
        </div>
        <div className="flex-1 space-y-0.5">
          <span className="text-sm font-medium">
            Ask the founder for credits
          </span>
          <p className="text-xs text-muted-foreground">
            Seriously. Tom replies.
          </p>
        </div>
      </div>
      <Textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            mutation.mutate();
          }
        }}
        placeholder="Tell Tom what you're making (optional)"
        rows={3}
        maxLength={2000}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(false)}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? 'Sending…' : 'Send request'}
        </Button>
      </div>
      {mutation.isError && (
        <p role="alert" className="text-xs text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : 'Failed to send request'}
        </p>
      )}
    </div>
  );
};

const ConnectedBadge: React.FC = () => (
  <Badge variant="default" className="gap-1 px-1.5 py-0 text-[10px]">
    <Check className="size-2.5" />
    Connected
  </Badge>
);

type ProviderCardProps = {
  logo: React.ReactNode;
  title: string;
  description: string;
  connected: boolean;
  children?: React.ReactNode;
};

const ProviderCard: React.FC<ProviderCardProps> = ({
  logo,
  title,
  description,
  connected,
  children,
}) => (
  <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 p-3.5">
    <div className="flex items-center gap-3.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        {logo}
      </div>
      <div className="flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {connected && <ConnectedBadge />}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
    {!connected && children}
  </div>
);

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
  const queryClient = useQueryClient();
  const posthog = usePostHog();
  const [falKeyInput, setFalKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) posthog.capture('billing_gate_shown', { reason, context });
  }, [open, reason, context, posthog]);

  const { data: profile } = useQuery({
    queryKey: ['currentUserProfile'],
    queryFn: () => getCurrentUserProfileFn(),
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const teamId = profile?.teamId;

  const saveFalKeyMutation = useMutation({
    mutationFn: (apiKey: string) => {
      if (!teamId) throw new Error('No team found');
      return saveApiKeyFn({ data: { teamId, provider: 'fal', apiKey } });
    },
    onSuccess: () => {
      setFalKeyInput('');
      setError(null);
      posthog.capture('api_key_saved', {
        provider: 'fal',
        source: 'billing_gate',
      });
      void queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['apiKeys', teamId] });
      void queryClient.invalidateQueries({
        queryKey: ['apiKeyStatus', teamId],
      });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    },
  });

  const handleSaveFalKey = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!falKeyInput.trim()) return;
    saveFalKeyMutation.mutate(falKeyInput.trim());
  };

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
          {stripeEnabled && (
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

              <div className="flex items-center gap-3 py-1">
                <Separator className="flex-1" />
                <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
                  or
                </span>
                <Separator className="flex-1" />
              </div>
            </>
          )}

          <ProviderCard
            logo={<FalLogo className="size-5" />}
            title="fal.ai"
            description="One key covers everything — images, video, audio, and script analysis."
            connected={hasFalKey}
          >
            <form onSubmit={handleSaveFalKey} className="flex gap-2">
              <Input
                name="falKey"
                type="password"
                placeholder="fal_…"
                value={falKeyInput}
                onChange={(e) => setFalKeyInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label="fal.ai API key"
                required
              />
              <Button
                type="submit"
                disabled={saveFalKeyMutation.isPending || !falKeyInput.trim()}
              >
                {saveFalKeyMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </form>
            <a
              href="https://fal.ai/dashboard/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Get a key from fal.ai
              <ExternalLink className="size-3" />
            </a>
          </ProviderCard>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <Link
            to="/credits"
            search={{ tab: 'gift-codes' }}
            onClick={handleNav}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
          >
            <Gift className="size-3.5" />
            Redeem a gift code
          </Link>
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
 * Globally-mounted gate instance (#1099), opened via `openBillingGate()` —
 * including by the query client's global mutation error handler on
 * INSUFFICIENT_CREDITS. The onboarding flow on the home composer keeps its own
 * instance for its dismissal memory.
 */
export const GlobalBillingGateDialog: React.FC = () => {
  const open = useBillingGateDialogOpen();
  const { data } = useBillingGateQuery();

  return (
    <BillingGateDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeBillingGate();
      }}
      hasFalKey={data?.hasFalKey ?? false}
      stripeEnabled={data?.stripeEnabled ?? true}
      reason={open ? getBillingGateReason() : undefined}
    />
  );
};
