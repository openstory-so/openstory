/**
 * Billing Constants
 * Central configuration for the credits/wallet billing system
 */

import { getEnv } from '#env';
import {
  type Microdollars,
  microsToDisplayUsd,
  microsToUsd,
  usdToMicros,
} from './money';

/** Whether Stripe payment processing is available (checkout, webhooks, auto-top-up). */
export function isStripeEnabled(): boolean {
  return !!getEnv().STRIPE_SECRET_KEY;
}

/**
 * Whether a new team gets the welcome grant in the user-create hook.
 *
 * Hosted Stripe pays on save-card / purchase, not at signup. e2e and
 * self-host (no Stripe key) still fund a first short at team create.
 * Gate is `E2E_TEST` or `!STRIPE_SECRET_KEY`, so CI stays funded even
 * when a Stripe key is in the env.
 */
export function grantsWelcomeCreditsOnSignup(): boolean {
  return getEnv().E2E_TEST === 'true' || !isStripeEnabled();
}

export function signupGrantIdempotencyKey(teamId: string): string {
  return `signup-grant:${teamId}`;
}

/**
 * Platform fee applied when purchasing credits (e.g., 0.07 = 7%).
 * Charged only on credit top-ups (Stripe checkout / auto top-up) — not on
 * each generation. Generations deduct wallet balance at lab rates.
 */
export const PLATFORM_FEE_PERCENT = 0.07;

/**
 * Welcome-grant amount in USD. Paid when a card is saved or a credit
 * purchase succeeds — not at team create, except e2e / self-host
 * (`grantsWelcomeCreditsOnSignup`). 0 still hides the dialog / signed-out
 * pill / pricing blurb (#1529).
 *
 * Must cover a typical first short with product defaults: Enhance 30s target
 * (~6 shots × 5s), stills + motion + music (Turbo: Nano Banana 2 Lite /
 * H3 Max / ElevenLabs). Guarded by the signup-grant test in
 * constants.test.ts.
 */
const SIGNUP_GRANT_USD = 20;

export const SIGNUP_GRANT_MICROS: Microdollars = usdToMicros(SIGNUP_GRANT_USD);

/**
 * Rough cost of another default short, used in the ready-email balance line
 * (#1276). Matches the issue copy ("about ~$13") rather than a live estimate
 * — pricing may be empty, and the point is "you probably can't fund a second
 * run", not a precise quote.
 */
export const TYPICAL_SHORT_COST_USD = 13;

/** Minimum top-up amount in USD */
export const MIN_TOPUP_AMOUNT_USD = 5;

/**
 * Amount the add-credits dialog and low-balance toast open on.
 * Higher than the floor so a one-click top-up still funds a typical short.
 */
export const DEFAULT_TOPUP_AMOUNT_USD = 10;

/** Minimum top-up amount in microdollars */
export const MIN_TOPUP_AMOUNT_MICROS: Microdollars =
  usdToMicros(MIN_TOPUP_AMOUNT_USD);

/**
 * Maximum top-up amount in USD. Enforced server-side on every path that can
 * move money: interactive checkout, direct saved-card purchase, and the
 * auto-top-up amount (which drives an unattended off-session charge).
 */
export const MAX_TOPUP_AMOUNT_USD = 1000;

/** Low balance warning threshold in USD (used when auto-top-up is disabled) */
export const LOW_BALANCE_THRESHOLD_USD = 5;

/** Minimum time between auto-top-up charges in milliseconds (60 seconds) */
export const AUTO_TOPUP_COOLDOWN_MS = 60_000;

/**
 * After a hard card decline, skip further auto-top-up PaymentIntents for
 * this long (#1334). Stripe returned `stripe-should-retry: false` on the
 * incident charges; retrying on every reservation debit/capture hammered
 * the same card 20 times in 8 minutes. A successful purchase, a settings
 * save, or a new default payment method clears the marker immediately.
 */
export const AUTO_TOPUP_DECLINE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * How long a run envelope stays in the available SUM (#1310).
 * Longer than AnalyzeScript's 90-minute image await plus 45-minute motion
 * await under burst, so in-flight capture still owns the row after
 * `expiresAt` would drop it from *new* reserves.
 */
export const RESERVATION_TTL_MS = 6 * 60 * 60 * 1000;

/** Number of months before credit batches expire */
const CREDIT_EXPIRY_MONTHS = 12;

/** Calculate the expiry date for a credit batch */
export function calculateExpiryDate(from?: Date): Date {
  const date = new Date(from ?? Date.now());
  date.setMonth(date.getMonth() + CREDIT_EXPIRY_MONTHS);
  return date;
}

/** Platform fee in USD for a credit purchase amount */
export function platformFeeUsd(creditAmountUsd: number): number {
  return creditAmountUsd * PLATFORM_FEE_PERCENT;
}

/** Total charged at checkout (credits + platform fee) */
export function totalCheckoutUsd(creditAmountUsd: number): number {
  return creditAmountUsd * (1 + PLATFORM_FEE_PERCENT);
}

/** Format platform fee percent for display (e.g. "7%") */
export function formatPlatformFeePercent(): string {
  return `${Math.round(PLATFORM_FEE_PERCENT * 100)}%`;
}

/** Split a credit purchase into credit + fee line items (USD, cents-rounded) */
export function splitCheckoutAmounts(creditAmountUsd: number): {
  creditUsd: number;
  feeUsd: number;
  totalUsd: number;
} {
  const creditCents = Math.round(creditAmountUsd * 100);
  const feeCents = Math.round(creditCents * PLATFORM_FEE_PERCENT);
  return {
    creditUsd: creditCents / 100,
    feeUsd: feeCents / 100,
    totalUsd: (creditCents + feeCents) / 100,
  };
}

/** Total Stripe charge in cents for a credit amount in microdollars */
export function totalCheckoutCents(creditAmountMicros: Microdollars): number {
  const { totalUsd } = splitCheckoutAmounts(microsToUsd(creditAmountMicros));
  return Math.round(totalUsd * 100);
}

type AddCredits = (
  amountMicros: Microdollars,
  opts: {
    type?: 'credit_adjustment';
    description?: string;
    metadata?: Record<string, unknown>;
    idempotencyKey?: string;
  }
) => Promise<{ newBalance: Microdollars; transactionId: string } | null>;

/** Callers must pass `hasSignupGrant()` — pre-#1516 rows have no idempotency key. */
export async function grantSignupCredits(opts: {
  teamId: string;
  addCredits: AddCredits;
  alreadyGranted: boolean;
}): Promise<{ granted: boolean; newBalance?: Microdollars }> {
  if (SIGNUP_GRANT_MICROS <= 0) return { granted: false };
  if (opts.alreadyGranted) return { granted: false };

  const result = await opts.addCredits(SIGNUP_GRANT_MICROS, {
    type: 'credit_adjustment',
    description: `Welcome credit: ${microsToDisplayUsd(SIGNUP_GRANT_MICROS)}`,
    idempotencyKey: signupGrantIdempotencyKey(opts.teamId),
    metadata: { signupGrant: true, gatedByCard: true },
  });

  if (!result) return { granted: false };
  return { granted: true, newBalance: result.newBalance };
}

export type WelcomeDialogMode = 'claim' | 'gift' | 'none';

/**
 * Which welcome surface to show.
 *
 * - `claim`: Stripe on and the grant is unpaid (BYOK spend does not suppress this).
 * - `gift`: Stripe off, grant exists, unused.
 * - `none`: the team already holds credits the grant did not give it, Stripe
 *   on and already granted, or Stripe off and (spent or no grant).
 */
export function welcomeDialogMode(input: {
  stripeEnabled: boolean;
  hasSignupGrant: boolean;
  hasUsedCredits: boolean;
  hasOtherCredits: boolean;
}): WelcomeDialogMode {
  if (input.hasOtherCredits) return 'none';
  if (input.stripeEnabled) {
    return input.hasSignupGrant ? 'none' : 'claim';
  }
  if (input.hasUsedCredits) return 'none';
  if (input.hasSignupGrant) return 'gift';
  return 'none';
}

/** Hosted Stripe, grant unpaid, and the grant amount is on. Generate should
 *  reopen the claim dialog instead of the billing gate. */
export function shouldOfferWelcomeClaim(input: {
  stripeEnabled: boolean;
  hasSignupGrant: boolean;
  hasOtherCredits: boolean;
}): boolean {
  if (SIGNUP_GRANT_MICROS <= 0) return false;
  if (input.hasOtherCredits) return false;
  return input.stripeEnabled && !input.hasSignupGrant;
}
