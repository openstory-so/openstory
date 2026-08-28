/**
 * Quiet credit-balance control in the sidebar footer (below the social
 * separator, above the user menu) — account chrome, not product nav (#1090).
 *
 * Visible when:
 * 1. Signed out — welcome-credit preview (grant amount, green) so new visitors
 *    see the free starting balance before they create an account (#1140)
 * 2. Low balance with no safety net (amber)
 * 3. Balance topped up — brief green flash
 * 4. User left "Show costs" on (default) — muted wallet amount (#1140)
 *
 * Expanded: wallet + $amount at normal sidebar foreground weight.
 * Collapsed (icon rail): wallet icon only + tooltip with amount — never the
 * dollar string, so it cannot overlap the avatar.
 *
 * Subscribes to team billing SSE only while visible and signed in.
 */

import { cn } from '@/lib/utils';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { openAddCreditsDialog } from '@/hooks/use-add-credits-dialog';
import { useBalanceFlash } from '@/hooks/use-balance-flash';
import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useBillingBalanceRealtime } from '@/hooks/use-billing-balance-realtime';
import { useBillingGateQuery } from '@/hooks/use-billing-gate';
import { useShowCosts } from '@/hooks/use-show-costs';
import { useUser } from '@/hooks/use-user';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';
import { microsToDisplayUsd } from '@/lib/billing/money';
import { Link } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';

const WELCOME_AMOUNT = microsToDisplayUsd(SIGNUP_GRANT_MICROS);

export const CreditBalancePill: React.FC = () => {
  const { data: user, isLoading: userLoading } = useUser();
  const { balance, reserved, teamId, isLowBalance } = useBillingBalance();
  const { data: gateStatus } = useBillingGateQuery();
  const { showCosts } = useShowCosts();
  const { isFlashing } = useBalanceFlash();

  const isSignedOut = !userLoading && !user;

  // A fal key alone covers generation (LLM calls route through fal's
  // OpenRouter endpoint); an OpenRouter key alone doesn't cover media.
  const hasSafetyNet = gateStatus?.hasAutoTopUp || gateStatus?.hasFalKey;

  const isLowBalanceVisible = isLowBalance && !hasSafetyNet;
  const isSignedInVisible = isLowBalanceVisible || showCosts || isFlashing;

  // SSE only while signed in and the pill is showing a live balance.
  useBillingBalanceRealtime(teamId, !isSignedOut && isSignedInVisible);

  if (isSignedOut) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip={`Welcome credits · ${WELCOME_AMOUNT} free on signup`}
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
