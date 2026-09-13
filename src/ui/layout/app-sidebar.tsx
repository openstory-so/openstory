import { usePostHog } from '@posthog/react';
import { GitHubIcon } from '@/ui/icons/github-icon';
import { XIcon } from '@/ui/icons/x-icon';
import { YouTubeIcon } from '@/ui/icons/youtube-icon';
import { OpenStoryIcon, OpenStoryLogo } from '@/ui/icons/openstory-logo';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/ui/shadcn/sidebar';
import { FeedbackDialog } from '@/platform/ui/feedback/feedback-dialog';
import { MODELS_ENABLED } from '@/platform/flags';
import { SITE_CONFIG } from '@/ui/marketing/constants';
import { Link, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useState, useRef } from 'react';
import {
  BadgeDollarSign,
  Boxes,
  Clapperboard,
  Film,
  Images,
  LifeBuoy,
  Mail,
  MapPin,
  Palette,
  Plus,
  Users,
  Video,
} from 'lucide-react';
import { CreditBalancePill } from './credit-balance-pill';
import { UserSidebarFooter } from './user-sidebar-footer';

/**
 * Low Balance Warning Hook
 * Fires toast notifications when balance decreases and crosses threshold,
 * and when a generation is rejected for insufficient credits (preflight
 * does not debit, so that path never looks like a balance drop).
 */

import { shouldOfferWelcomeClaim } from '@/billing/constants';
import { showLowBalanceToast } from '@/billing/ui/low-balance-toast';
import { typicalShortCostUsd } from '@/billing/ui/typical-short-cost';
import { subscribeInsufficientCredits } from '@/billing/ui/notify-insufficient-credits';
import { openAddCreditsDialog } from '@/billing/ui/use-add-credits-dialog';
import { openBillingGate } from '@/billing/ui/use-billing-gate-dialog';
import { useBillingBalance } from '@/billing/ui/use-billing-balance';
import { useFalPricing } from '@/billing/ui/use-fal-pricing';
import { useWelcomeCreditsGate } from '@/billing/ui/welcome-credits-dialog';

function useLowBalanceWarning() {
  const {
    balance,
    isLowBalance,
    isZeroBalance,
    lowBalanceThreshold,
    stripeEnabled,
    hasSignupGrant,
    hasOtherCredits,
  } = useBillingBalance();
  const { reopen: reopenWelcomeCredits } = useWelcomeCreditsGate();
  const { pricing } = useFalPricing();
  const posthog = usePostHog();
  const prevBalanceRef = useRef<number | null>(null);
  const hasWarnedRef = useRef(false);

  const fireToast = useCallback(
    (source: 'balance_drop' | 'insufficient_credits') => {
      if (
        shouldOfferWelcomeClaim({
          stripeEnabled,
          hasSignupGrant,
          hasOtherCredits,
        })
      ) {
        reopenWelcomeCredits();
        return;
      }
      const balanceUsd = balance ?? 0;
      const zero = balance === null ? true : isZeroBalance;
      const props = {
        balance_usd: balanceUsd,
        is_zero: zero,
        source,
      };
      posthog.capture('low_balance_toast_shown', props);

      const clicked = (choice: 'add_credits' | 'other_options') =>
        posthog.capture('low_balance_toast_clicked', { ...props, choice });

      showLowBalanceToast({
        balanceUsd,
        isZeroBalance: zero,
        runCostUsd: typicalShortCostUsd(pricing),
        onAddCredits: () => {
          clicked('add_credits');
          openAddCreditsDialog('low_balance_toast');
        },
        onOtherOptions: () => {
          clicked('other_options');
          openBillingGate(zero ? 'zero' : 'insufficient');
        },
      });
    },
    [
      balance,
      isZeroBalance,
      posthog,
      pricing,
      stripeEnabled,
      hasSignupGrant,
      hasOtherCredits,
      reopenWelcomeCredits,
    ]
  );

  useEffect(() => {
    return subscribeInsufficientCredits(() => {
      fireToast('insufficient_credits');
    });
  }, [fireToast]);

  useEffect(() => {
    if (balance === null) return;

    const prevBalance = prevBalanceRef.current;
    prevBalanceRef.current = balance;

    // Only warn on balance decrease, not on initial load
    if (prevBalance === null) return;
    if (balance >= prevBalance) {
      // Balance went up — reset warning so it can fire again next time
      if (balance > lowBalanceThreshold) {
        hasWarnedRef.current = false;
      }
      return;
    }

    // Balance decreased — check if we should warn
    if (hasWarnedRef.current) return;
    if (!isZeroBalance && !isLowBalance) return;

    hasWarnedRef.current = true;
    fireToast('balance_drop');
  }, [balance, fireToast, isLowBalance, isZeroBalance, lowBalanceThreshold]);
}

const navLinks = [
  { to: '/sequences', label: 'Sequences', icon: Video },
  { to: '/images', label: 'Images', icon: Images },
  { to: '/videos', label: 'Videos', icon: Film },
  ...(MODELS_ENABLED
    ? [{ to: '/models', label: 'Models', icon: Boxes } as const]
    : []),
  { to: '/styles', label: 'Styles', icon: Palette },
  { to: '/talent', label: 'Talent', icon: Users },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/gallery', label: 'Gallery', icon: Clapperboard },
] as const;

export function AppSidebar() {
  useLowBalanceWarning();

  const { isMobile, setOpenMobile } = useSidebar();
  const posthog = usePostHog();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          to="/"
          className="flex h-10 items-center px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <OpenStoryLogo
            size="md"
            className="group-data-[collapsible=icon]:hidden"
          />
          <OpenStoryIcon
            size="md"
            className="hidden group-data-[collapsible=icon]:block"
          />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="New sequence">
                  {/* `/` is the free composer for everyone (#1104); the
                      signed-in alias `/sequences/new` is for copy/breadcrumb
                      entry points that require a session. */}
                  <Link
                    to="/"
                    onClick={() =>
                      posthog.capture('make_another_clicked', {
                        surface: 'sidebar',
                      })
                    }
                  >
                    <Plus />
                    <span>New sequence</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {navLinks.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={label}>
                  <SidebarMenuButton asChild tooltip={label}>
                    <Link
                      to={to}
                      activeProps={{ 'data-active': 'true' }}
                      activeOptions={{ exact: false }}
                    >
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Guide">
              <Link to="/docs">
                <LifeBuoy />
                <span>Guide</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Pricing">
              <Link to="/pricing">
                <BadgeDollarSign />
                <span>Pricing</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Feedback"
              onClick={() => setFeedbackOpen(true)}
            >
              <Mail />
              <span>Feedback</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="GitHub">
              <a href={SITE_CONFIG.githubHref} target="_blank" rel="noreferrer">
                <GitHubIcon className="size-4" />
                <span>GitHub</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="YouTube">
              <a
                href={SITE_CONFIG.youtubeHref}
                target="_blank"
                rel="noreferrer"
              >
                <YouTubeIcon className="size-4" />
                <span>YouTube</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Follow OpenStory">
              <a href={SITE_CONFIG.xHref} target="_blank" rel="noreferrer">
                <XIcon className="size-4" />
                <span>Follow OpenStory</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        {/* Quiet status chip — not a nav peer of Sequences/Gallery (#1090). */}
        <CreditBalancePill />
        <SidebarMenu>
          <UserSidebarFooter />
        </SidebarMenu>
      </SidebarFooter>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </Sidebar>
  );
}
