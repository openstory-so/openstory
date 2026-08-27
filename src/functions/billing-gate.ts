/**
 * Billing Gate Server Function
 * Combined endpoint returning balance + BYOK status for billing gate checks
 */

import { createServerFn } from '@tanstack/react-start';
import { authWithTeamMiddleware } from './middleware';
import { isStripeEnabled } from '@/lib/billing/constants';
import { microsToUsd } from '@/lib/billing/money';

/**
 * Check billing gate status: balance, BYOK keys, and auto-top-up
 * Uses member-level auth (not admin-only like checkApiKeyStatusFn)
 */
export const getBillingGateStatusFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb } = context;

    // `hasUsableKey` (not `hasKey`): these flags render as "connected"/BYOK
    // coverage in the billing gate — a key flagged invalid is skipped at call
    // time (the platform key pays), so it must not count as coverage.
    const [
      funds,
      hasFalKey,
      hasOpenRouterKey,
      openRouterKeyInvalid,
      falKeyInvalid,
      billingSettings,
    ] = await Promise.all([
      scopedDb.billing.getAvailable(),
      scopedDb.apiKeys.hasUsableKey('fal'),
      scopedDb.apiKeys.hasUsableKey('openrouter'),
      scopedDb.apiKeys.hasInvalidKey('openrouter'),
      scopedDb.apiKeys.hasInvalidKey('fal'),
      scopedDb.billing.getBillingSettings(),
    ]);

    return {
      hasCredits: funds.available > 0,
      hasFalKey,
      hasOpenRouterKey,
      openRouterKeyInvalid,
      falKeyInvalid,
      balance: microsToUsd(funds.available),
      hasAutoTopUp:
        billingSettings.autoTopUpEnabled &&
        !!billingSettings.stripeCustomerId &&
        !billingSettings.autoTopUpFailedAt,
      stripeEnabled: isStripeEnabled(),
    };
  });
