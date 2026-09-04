/**
 * Stripe Checkout Service
 * Creates checkout sessions for credit top-ups
 */

import { ValidationError } from '@/lib/errors';
import {
  formatPlatformFeePercent,
  MIN_TOPUP_AMOUNT_USD,
  splitCheckoutAmounts,
} from './constants';
import { captureCheckoutOpened } from './checkout-events';
import type { ScopedDb } from '@/lib/db/scoped';
import { getStripeOrThrow } from './stripe';

type CreateCheckoutParams = {
  scopedDb: ScopedDb;
  teamId: string;
  amountUsd: number;
  userId: string;
  userEmail: string;
  successUrl: string;
  cancelUrl: string;
  /** Copied from `add_credits_clicked` so webhook events keep the surface. */
  surface?: string;
};

export async function createCheckoutSession(
  params: CreateCheckoutParams
): Promise<{ url: string }> {
  const {
    scopedDb,
    teamId,
    amountUsd,
    userId,
    userEmail,
    successUrl,
    cancelUrl,
    surface,
  } = params;

  if (amountUsd < MIN_TOPUP_AMOUNT_USD) {
    throw new ValidationError(
      `Minimum top-up amount is $${MIN_TOPUP_AMOUNT_USD}`
    );
  }

  const stripe = getStripeOrThrow();
  const settings = await scopedDb.billing.getBillingSettings();

  // Reuse existing Stripe customer or create new one
  let customerId = settings.stripeCustomerId;
  if (customerId) {
    // Verify the customer still exists in Stripe (may differ between environments)
    try {
      const existing = await stripe.customers.retrieve(customerId);
      if (existing.deleted) {
        customerId = null;
      }
    } catch {
      customerId = null;
    }
  }
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: { teamId, userId },
    });
    customerId = customer.id;
    await scopedDb.billing.saveStripeCustomerId(customerId);
  }

  const { creditUsd, feeUsd } = splitCheckoutAmounts(amountUsd);
  const creditCents = Math.round(creditUsd * 100);
  const feeCents = Math.round(feeUsd * 100);
  const feeLabel = formatPlatformFeePercent();

  // Copied onto the PaymentIntent so `payment_intent.*` webhooks pass
  // stripeWebhookMiddleware (it requires teamId + userId on the object).
  const metadata: Record<string, string> = {
    teamId,
    userId,
    amountUsd: String(amountUsd),
    type: 'credit_top_up',
    method: 'checkout',
    ...(surface ? { surface } : {}),
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    payment_method_types: ['card'],
    // Save the payment method for auto-top-up
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata,
    },
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: creditCents,
          product_data: {
            name: `Credits — $${creditUsd.toFixed(2)}`,
            description: `Add $${creditUsd.toFixed(2)} to your team wallet`,
          },
        },
        quantity: 1,
      },
      {
        price_data: {
          currency: 'usd',
          unit_amount: feeCents,
          product_data: {
            name: `Platform fee (${feeLabel})`,
            description: `One-time platform fee on credit purchases. Generations deduct credits at lab rates with no extra fee.`,
          },
        },
        quantity: 1,
      },
    ],
    metadata,
    customer_update: {
      address: 'auto',
      name: 'auto',
    },
    tax_id_collection: {
      enabled: true,
    },
    automatic_tax: {
      enabled: true,
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  captureCheckoutOpened({
    distinctId: userId,
    teamId,
    amountUsd,
    method: 'checkout',
    stripeCheckoutSessionId: session.id,
    ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    ...(surface ? { surface } : {}),
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL');
  }

  return { url: session.url };
}
