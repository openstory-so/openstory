/**
 * Likely cost label under a generation action (#1140).
 *
 * Renders nothing when:
 * - the user turned "Show costs" off (default is ON)
 * - there is no estimate (null/undefined) — never invent a number here
 * - estimate is still loading and no value yet
 *
 * Logged out: the amount slot is the glyph `~$x.xx`, not a calculated
 * figure, unless `hideLoggedOutPrice` (the front-page sign-in generate
 * button). The estimate fn is authed; we do not call it (#1575).
 *
 * Callers should pass an honest single-action estimate (`estimateImageCost` /
 * video / audio → null when unknown). Storyboard totals from
 * `estimateStoryboardCost` may still embed gate floors for unpriced
 * subcomponents after a primary-image honesty check.
 *
 * Prefixes with `~` — these are pre-flight estimates; billed units may differ.
 * When the signed-in wallet balance is below the estimate (and generation is
 * not covered by a team fal key), the amount is amber so over-budget is obvious.
 * On a primary button pass `onPrimary` — that fill stays light in dark mode,
 * where the page amber is too pale. The amount sits in the button
 * (`InButtonCost`); over budget is the warning icon and colour, not extra words.
 * `undefined` is still calculating: a skeleton holds the amount's width so the
 * button does not jump when the number arrives. `null` is no honest price.
 */

import { useBillingBalance } from './use-billing-balance';
import { useBillingGateQuery } from './use-billing-gate';
import { useShowCosts } from './use-show-costs';
import {
  microsToDisplayUsd,
  microsToUsd,
  type Microdollars,
} from '@/billing/money';
import { useAuthSession } from '@/platform/ui/auth/session-query';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { cn } from '@/ui/utils';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

type ActionCostProps = {
  /** Honest estimate, or null when pricing is unknown for this action. */
  estimate: Microdollars | null | undefined;
  className?: string;
  /** Align under a full-width button vs. a right-aligned primary CTA. */
  align?: 'center' | 'end' | 'start';
  /**
   * Copy before the amount, e.g. "Until References". Shown even when the
   * amount is not (costs hidden, or no honest estimate) — it is the caller's
   * control, not part of the number.
   */
  prefix?: ReactNode;
  /**
   * The amount is painted on the primary button (light in both themes).
   * Dark-mode amber is for the page background and washes out on that fill.
   */
  onPrimary?: boolean;
  /**
   * Inside a button. A missing honest price (`null`) renders nothing; a
   * price still loading (`undefined`) keeps the skeleton. The cost is
   * `aria-hidden` so it does not rename the button ("Generate" stays
   * "Generate"; "sign in" in the logged-out label must not match Sign in).
   */
  inline?: boolean;
  /**
   * Width of the loading skeleton. Motion totals are usually two digits
   * (`~$00.00`); earlier steps are usually one (`~$0.00`).
   */
  amountWidth?: 'single' | 'double';
  /**
   * Logged-out placeholder `~$x.xx` is a stand-in, not a price. The front-page
   * generate button is the sign-in control and must not show it.
   */
  hideLoggedOutPrice?: boolean;
};

/** Label + price, wrapping together inside a generate button. */
export function InButtonCost({
  children,
  estimate,
  onPrimary = true,
  amountWidth = 'single',
  hideLoggedOutPrice = false,
}: {
  children: ReactNode;
  estimate: Microdollars | null | undefined;
  onPrimary?: boolean;
  /** Motion totals reserve two digits; earlier steps reserve one. */
  amountWidth?: 'single' | 'double';
  /** Drop the logged-out `~$x.xx` stand-in. */
  hideLoggedOutPrice?: boolean;
}) {
  return (
    <span className="inline-flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5">
      {children}
      <ActionCost
        estimate={estimate}
        onPrimary={onPrimary}
        inline
        amountWidth={amountWidth}
        hideLoggedOutPrice={hideLoggedOutPrice}
      />
    </span>
  );
}

/** Lets a wrapped price fit a full-width generate button. */
export const costButtonClassName =
  'h-auto min-h-8 w-full whitespace-normal py-1.5';

export function ActionCost({
  estimate,
  className,
  align = 'center',
  prefix,
  onPrimary = false,
  inline = false,
  amountWidth = 'single',
  hideLoggedOutPrice = false,
}: ActionCostProps) {
  const { showCosts } = useShowCosts();
  const { data: session } = useAuthSession();
  const { balance } = useBillingBalance();
  const { data: gate } = useBillingGateQuery();

  const justify = cn(
    'flex max-w-full flex-wrap items-center gap-1 text-xs whitespace-normal',
    align === 'end' && 'justify-end',
    align === 'start' && 'justify-start',
    align === 'center' && 'justify-center'
  );

  if (!showCosts) {
    if (inline || !prefix) return null;
    return (
      <span className={cn(justify, 'text-muted-foreground', className)}>
        {prefix}
      </span>
    );
  }
  if (!session) {
    if (hideLoggedOutPrice) {
      if (inline || !prefix) return null;
      return (
        <span className={cn(justify, 'text-muted-foreground', className)}>
          {prefix}
        </span>
      );
    }
    return (
      <span
        className={cn(
          justify,
          'min-h-4 tabular-nums text-muted-foreground',
          className
        )}
        {...(inline
          ? { 'aria-hidden': true as const }
          : { 'aria-label': 'Estimated cost shown after sign in' })}
      >
        {prefix}
        <span>~$x.xx</span>
      </span>
    );
  }
  // Still calculating. The skeleton is the width of a short amount so the
  // button does not grow when the figure lands.
  if (estimate === undefined) {
    return (
      <span
        className={cn(justify, 'min-h-4', className)}
        {...(inline
          ? { 'aria-hidden': true as const }
          : { 'aria-busy': true as const, 'aria-label': 'Estimating cost' })}
      >
        {prefix}
        <span className="relative inline-flex">
          <span className="invisible tabular-nums" aria-hidden>
            {amountWidth === 'double' ? '~$00.00' : '~$0.00'}
          </span>
          <Skeleton
            className={cn(
              'absolute inset-y-0.5 inset-x-0',
              onPrimary ? 'bg-primary-foreground/25' : 'bg-foreground/15'
            )}
          />
        </span>
      </span>
    );
  }
  if (estimate == null) {
    if (inline) return null;
    return (
      <span className={cn(justify, 'min-h-4 text-muted-foreground', className)}>
        {prefix}
      </span>
    );
  }

  // Wallet path only — team fal key covers media (and LLM when routed via fal).
  // OpenRouter-only BYOK is not checked here.
  const walletApplies = !gate?.hasFalKey;
  const estimateUsd = microsToUsd(estimate);
  const exceedsBalance =
    walletApplies &&
    balance !== null &&
    Number.isFinite(balance) &&
    estimateUsd > balance;

  const amount = microsToDisplayUsd(estimate);
  const label = exceedsBalance
    ? `Estimated cost about ${amount}, more than your credit balance`
    : `Estimated cost about ${amount}`;

  return (
    <span
      className={cn(
        justify,
        'tabular-nums',
        exceedsBalance
          ? onPrimary
            ? 'text-amber-800'
            : 'text-amber-600 dark:text-amber-400'
          : onPrimary
            ? 'text-primary-foreground/70'
            : 'text-muted-foreground',
        className
      )}
      {...(inline ? { 'aria-hidden': true as const } : { 'aria-label': label })}
    >
      {prefix}
      {exceedsBalance ? (
        <AlertTriangle className="size-3 shrink-0" aria-hidden />
      ) : null}
      <span>~{amount}</span>
    </span>
  );
}
