/**
 * Billing Gate Hook
 * Combines balance + BYOK status to gate credit-consuming actions
 */

import { useQuery } from '@tanstack/react-query';
import { useAuthSession } from '@/lib/auth/session-query';
import { getBillingGateStatusFn } from '@/functions/billing-gate';
import { openBillingGate } from './use-billing-gate-dialog';

export const BILLING_GATE_KEY = ['billing-gate-byok'] as const;

type BillingGateStatus = {
  hasCredits: boolean;
  hasFalKey: boolean;
  hasOpenRouterKey: boolean;
  openRouterKeyInvalid: boolean;
  falKeyInvalid: boolean;
  balance: number;
  hasAutoTopUp: boolean;
  stripeEnabled: boolean;
};

export function useBillingGateQuery() {
  const { data: session } = useAuthSession();

  return useQuery({
    queryKey: [...BILLING_GATE_KEY],
    queryFn: () => getBillingGateStatusFn(),
    staleTime: 60_000,
    enabled: !!session,
  });
}

/**
 * Check if BYOK keys cover generation. A fal key alone is enough: media
 * calls hit fal directly and LLM calls route through fal's OpenRouter
 * endpoint (issue #895). An OpenRouter key alone is NOT enough — image,
 * video, and audio generation all need fal.
 */
function hasByokCoverage(data: BillingGateStatus): boolean {
  return data.hasFalKey;
}

/**
 * Gate for credit-consuming actions. A team fal key bypasses credits for
 * everything (LLM calls route through fal's OpenRouter endpoint).
 */
export function useBillingGate() {
  const query = useBillingGateQuery();

  const data: BillingGateStatus | undefined = query.data;

  const canGenerate = data
    ? data.hasCredits || hasByokCoverage(data) || data.hasAutoTopUp
    : true; // Don't block while loading

  const needsBillingSetup = data
    ? !data.hasCredits && !hasByokCoverage(data) && !data.hasAutoTopUp
    : false;

  return {
    canGenerate,
    needsBillingSetup,
    hasFalKey: data?.hasFalKey ?? false,
    hasOpenRouterKey: data?.hasOpenRouterKey ?? false,
    openRouterKeyInvalid: data?.openRouterKeyInvalid ?? false,
    falKeyInvalid: data?.falKeyInvalid ?? false,
    hasCredits: data?.hasCredits ?? true,
    hasAutoTopUp: data?.hasAutoTopUp ?? false,
    stripeEnabled: data?.stripeEnabled ?? true,
    // Opens the globally-mounted gate dialog (#1099)
    showGate: openBillingGate,
    isLoading: query.isLoading,
  };
}

/** Alias kept for call-site readability at image/motion call sites. */
export function useFalBillingGate() {
  return useBillingGate();
}
