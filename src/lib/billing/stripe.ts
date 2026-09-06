/**
 * Stripe Client
 * Lazy-initialized Stripe instance for billing operations.
 * Returns null when STRIPE_SECRET_KEY is not configured (billing disabled).
 */

import { getEnv } from '#env';
import { OpenStoryError } from '@/shared/errors';
import Stripe from 'stripe';

let stripeInstance: Stripe | null = null;
let stripeChecked = false;

/**
 * Get Stripe instance, or null if not configured.
 * Use `getStripeOrThrow()` when Stripe is required (e.g. checkout).
 */
function getStripe(): Stripe | null {
  if (stripeChecked) return stripeInstance;

  const env = getEnv();
  const key = env.STRIPE_SECRET_KEY;

  if (!key) {
    stripeChecked = true;
    return null;
  }

  stripeInstance = new Stripe(key, {
    typescript: true,
  });
  stripeChecked = true;

  return stripeInstance;
}

/**
 * Get Stripe instance or throw if not configured.
 * Use this in billing routes that require Stripe.
 */
export function getStripeOrThrow(): Stripe {
  const stripe = getStripe();
  if (!stripe) {
    throw new OpenStoryError(
      'STRIPE_SECRET_KEY environment variable is required for billing',
      'CONFIGURATION_ERROR'
    );
  }
  return stripe;
}

export function getStripeWebhookSecret(): string | null {
  const env = getEnv();
  return env.STRIPE_WEBHOOK_SECRET || null;
}
