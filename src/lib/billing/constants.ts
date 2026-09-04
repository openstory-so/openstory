/**
 * Billing Constants
 * Central configuration for the credits/wallet billing system
 */

import { getEnv } from '#env';
import { type Microdollars, usdToMicros, microsToUsd } from './money';

/** Whether Stripe payment processing is available (checkout, webhooks, auto-top-up). */
export function isStripeEnabled(): boolean {
  return !!getEnv().STRIPE_SECRET_KEY;
}

/**
 * Platform fee applied when purchasing credits (e.g., 0.07 = 7%).
 * Charged only on credit top-ups (Stripe checkout / auto top-up) — not on
 * each generation. Generations deduct wallet balance at lab rates.
 */
export const PLATFORM_FEE_PERCENT = 0.07;

/**
 * Free credit granted to every new team on signup, in USD.
 *
 * Must cover a typical first short with product defaults: Enhance 30s target
 * (~6 shots × 5s), stills + motion + music (Turbo: Nano Banana 2 Lite /
 * H3 Max / ElevenLabs). Guarded by the signup-grant test in
 * constants.test.ts. Preflight uses fal historical typicalUnitsPerCall
 * (not raw unitPrice alone). Raised from $10 when motion+music became the
 * default aha path (#1140).
 */
const SIGNUP_GRANT_USD = 20;

/** Free credit granted to every new team on signup, in microdollars */
export const SIGNUP_GRANT_MICROS: Microdollars = usdToMicros(SIGNUP_GRANT_USD);

/**
 * Rough cost of another default short, used in the ready-email balance line
 * (#1276). Matches the issue copy ("about ~$13") rather than a live estimate
 * — pricing may be empty, and the point is "you probably can't fund a second
 * run", not a precise quote.
 */
export const TYPICAL_SHORT_COST_USD = 13;

/** Minimum top-up amount in USD */
export const MIN_TOPUP_AMOUNT_USD = 10;

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
