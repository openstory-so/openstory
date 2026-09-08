/**
 * Quiet credit-balance control in the sidebar footer (below the social
 * separator, above the user menu) — account chrome, not product nav (#1090).
 *
 * Visible when:
 * 1. Signed out — welcome-credit preview (grant amount, green) so visitors
 *    see what they can claim after saving a card (#1140, #1516)
 * 2. Signed in with an unclaimed welcome grant — real wallet amount, green;
 *    click reopens the claim dialog after Skip. Never show the grant amount
 *    as if it were the balance.
 * 3. Low balance with no safety net (amber)
 * 4. Balance topped up — brief green flash
 * 5. User left "Show costs" on (default) — muted wallet amount (#1140)
 *
 * Expanded: wallet + $amount at normal sidebar foreground weight.
 * Collapsed (icon rail): wallet icon only + tooltip with amount — never the
 * dollar string, so it cannot overlap the avatar.
 *
 * Subscribes to team billing SSE only while visible and signed in.
 */

import { cn } from '@/shared/utils';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useWelcomeCreditsGate } from '@/components/billing/welcome-credits-dialog';
import { openAddCreditsDialog } from '@/hooks/use-add-credits-dialog';
import { useBalanceFlash } from '@/hooks/use-balance-flash';
import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useBillingBalanceRealtime } from '@/hooks/use-billing-balance-realtime';
import { useBillingGateQuery } from '@/hooks/use-billing-gate';
import { useShowCosts } from '@/hooks/use-show-costs';
import { useUser } from '@/hooks/use-user';
import {
  SIGNUP_GRANT_MICROS,
  shouldOfferWelcomeClaim,
} from '@/lib/billing/constants';
import { microsToDisplayUsd } from '@/lib/billing/money';
import { Link } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';

const WELCOME_AMOUNT = microsToDisplayUsd(SIGNUP_GRANT_MICROS);

export const CreditBalancePill: React.FC = () => {
  const { data: user, isLoading: userLoading } = useUser();
  const {
    balance,
    reserved,
    teamId,
    isLowBalance,
    stripeEnabled,
    hasSignupGrant,
    hasOtherCredits,
  } = useBillingBalance();
  const { data: gateStatus } = useBillingGateQuery();
  const { showCosts } = useShowCosts();
  const { isFlashing } = useBalanceFlash();
  const { reopen: reopenWelcomeCredits } = useWelcomeCreditsGate();

  const isSignedOut = !userLoading && !user;
  const unclaimedWelcome = Boolean(
    user &&
    shouldOfferWelcomeClaim({ stripeEnabled, hasSignupGrant, hasOtherCredits })
  );

  // A fal key alone covers generation (LLM calls route through fal's
  // OpenRouter endpoint); an OpenRouter key alone doesn't cover media.
  const hasSafetyNet = gateStatus?.hasAutoTopUp || gateStatus?.hasFalKey;

  const isLowBalanceVisible = isLowBalance && !hasSafetyNet;
  const isSignedInVisible = isLowBalanceVisible || showCosts || isFlashing;

  // SSE while signed in and the pill is showing a live balance — including
  // the unclaimed CTA, so a grant that lands does not leave a stale $0.
  useBillingBalanceRealtime(
    teamId,
    !isSignedOut && (isSignedInVisible || unclaimedWelcome)
  );

  if (isSignedOut) {
    // Free credits off (#1529): nothing to preview.
    if (SIGNUP_GRANT_MICROS <= 0) return null;
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip={`Welcome credits · ${WELCOME_AMOUNT} to claim`}
            className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400"
          >
            <Link
              to="/login"
              aria-label={`Welcome credits ${WELCOME_AMOUNT}. Sign in to claim.`}
            >
              <Wallet />
              <span className="tabular-nums" aria-live="polite">
                {WELCOME_AMOUNT}
              </span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  if (unclaimedWelcome) {
    const amount = `$${balance?.toFixed(2) ?? '0.00'}`;
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={`Claim ${WELCOME_AMOUNT} welcome credits`}
            onClick={() => reopenWelcomeCredits()}
            aria-label={`Credit balance ${amount}. Claim ${WELCOME_AMOUNT} welcome credits.`}
            className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400"
          >
            <Wallet />
            <span className="tabular-nums" aria-live="polite">
              {amount}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  if (!isSignedInVisible) return null;

  // Flash / low only — default inherits sidebar menu foreground (not muted).
  const toneClass = isFlashing
    ? 'text-emerald-600 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-400'
    : isLowBalanceVisible
      ? 'text-amber-600 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-400'
      : undefined;

  const amount = `$${balance?.toFixed(2) ?? '0.00'}`;
  const tooltip =
    reserved > 0 ? `Credits · ${amount} available` : `Credits · ${amount}`;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {/* Opens the add-credits modal, not the credits page (#1099) */}
        <SidebarMenuButton
          tooltip={tooltip}
          onClick={() => openAddCreditsDialog('sidebar_pill')}
          aria-label={`Credit balance ${amount}. Add credits.`}
          className={cn(
            'animate-[balance-flash-in_300ms_ease-out_both]',
            toneClass
          )}
        >
          <Wallet />
          {/* Amount hides in icon mode via SidebarMenuButton truncation
              (span:last-child); tooltip carries the full amount. */}
          <span className="tabular-nums" aria-live="polite">
            {amount}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};
