/**
 * Stripe Checkout Service
 * Credit top-up Checkout sessions.
 */

import { ValidationError } from '@/platform/errors';
import {
  formatPlatformFeePercent,
  MIN_TOPUP_AMOUNT_USD,
  splitCheckoutAmounts,
} from '@/billing/constants';
import { captureCheckoutOpened } from './checkout-events';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { getStripeOrThrow } from './stripe';
import type Stripe from 'stripe';

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

async function ensureStripeCustomer(opts: {
  stripe: Stripe;
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  userEmail: string;
}): Promise<string> {
  const settings = await opts.scopedDb.billing.getBillingSettings();
  let customerId = settings.stripeCustomerId;
  if (customerId) {
    try {
      const existing = await opts.stripe.customers.retrieve(customerId);
      if (existing.deleted) {
        customerId = null;
      }
    } catch {
      customerId = null;
    }
  }
  if (!customerId) {
    const customer = await opts.stripe.customers.create({
      email: opts.userEmail,
      metadata: { teamId: opts.teamId, userId: opts.userId },
    });
    customerId = customer.id;
    await opts.scopedDb.billing.saveStripeCustomerId(customerId);
  }
  return customerId;
}

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
  const customerId = await ensureStripeCustomer({
    stripe,
    scopedDb,
    teamId,
    userId,
    userEmail,
  });

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
    // No `payment_method_types`: Stripe shows what is enabled in the Dashboard
    // (card, Alipay, WeChat Pay — #1537) and only when eligible for the
    // currency, so a wallet that is off or unavailable can never break
    // checkout. Alipay / WeChat Pay are single-use, so the card is the only
    // method saved for auto-top-up — a session-level `setup_future_usage`
    // would hide the wallets.
    payment_method_options: {
      card: { setup_future_usage: 'off_session' },
      wechat_pay: { client: 'web' },
    },
    payment_intent_data: { metadata },
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

export async function teamHasSavedCard(scopedDb: ScopedDb): Promise<boolean> {
  const settings = await scopedDb.billing.getBillingSettings();
  if (!settings.stripeCustomerId) return false;
  const stripe = getStripeOrThrow();
  const methods = await stripe.paymentMethods.list({
    customer: settings.stripeCustomerId,
    type: 'card',
    limit: 1,
  });
  return methods.data.length > 0;
}
