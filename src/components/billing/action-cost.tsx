/**
 * Likely cost label under a generation action (#1140).
 *
 * Renders nothing when:
 * - the user turned "Show costs" off (default is ON)
 * - there is no estimate (null/undefined) — never invent a number here
 * - estimate is still loading and no value yet
 *
 * Callers should pass an honest single-action estimate (`estimateImageCost` /
 * video / audio → null when unknown). Storyboard totals from
 * `estimateStoryboardCost` may still embed gate floors for unpriced
 * subcomponents after a primary-image honesty check.
 *
 * Prefixes with `~` — these are pre-flight estimates; billed units may differ.
 * When the signed-in wallet balance is below the estimate (and generation is
 * not covered by a team fal key), the amount is amber so over-budget is obvious.
 */

import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useBillingGateQuery } from '@/hooks/use-billing-gate';
import { useShowCosts } from '@/hooks/use-show-costs';
import {
  microsToDisplayUsd,
  microsToUsd,
  type Microdollars,
} from '@/lib/billing/money';
import { cn } from '@/lib/utils';
import { AlertTriangle } from 'lucide-react';

type ActionCostProps = {
  /** Honest estimate, or null when pricing is unknown for this action. */
  estimate: Microdollars | null | undefined;
  className?: string;
  /** Align under a full-width button vs. a right-aligned primary CTA. */
  align?: 'center' | 'end' | 'start';
};

export function ActionCost({
  estimate,
  className,
  align = 'center',
}: ActionCostProps) {
  const { showCosts } = useShowCosts();
  const { balance } = useBillingBalance();
  const { data: gate } = useBillingGateQuery();

  if (!showCosts || estimate == null) return null;

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
        'flex items-center gap-1 text-xs tabular-nums',
        align === 'end' && 'justify-end',
        align === 'start' && 'justify-start',
        align === 'center' && 'justify-center',
        exceedsBalance
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-muted-foreground',
        className
      )}
      aria-label={label}
    >
      {exceedsBalance ? (
        <AlertTriangle className="size-3 shrink-0" aria-hidden />
      ) : null}
      <span>
        ~{amount}
        {exceedsBalance && <span> · over balance</span>}
      </span>
    </span>
  );
}
