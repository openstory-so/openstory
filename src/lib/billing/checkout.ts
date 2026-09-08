/**
 * Stripe Checkout Service
 * Credit top-up Checkout sessions and save-card setup (#1516).
 */

import {
  ValidationError,
  WelcomeCardAlreadyClaimedError,
} from '@/shared/errors';
import { captureProductEvent } from '@/lib/observability/product-events';
import {
  formatPlatformFeePercent,
  grantSignupCredits,
  MIN_TOPUP_AMOUNT_USD,
  SIGNUP_GRANT_MICROS,
  splitCheckoutAmounts,
} from './constants';
import { microsToUsd } from './money';
import { captureCheckoutOpened } from './checkout-events';
import type { ScopedDb } from '@/lib/db/scoped';
import { getStripeOrThrow } from './stripe';
import type Stripe from 'stripe';

/** Metadata `type` for save-card Checkout / SetupIntent — no charge. */
export const SAVE_CARD_METADATA_TYPE = 'save_card';

async function cardFingerprint(paymentMethodId: string): Promise<string> {
  const stripe = getStripeOrThrow();
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
  const fingerprint = pm.card?.fingerprint;
  if (!fingerprint) {
    throw new ValidationError(
      'This card cannot be used to claim welcome credits'
    );
  }
  return fingerprint;
}

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

type CreateSetupCheckoutParams = {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  userEmail: string;
  successUrl: string;
  cancelUrl: string;
};

/**
 * Checkout in `mode: 'setup'` — Stripe's UI says save a card, not pay.
 * Webhook middleware requires teamId + userId on the object metadata, so
 * both the session and the SetupIntent carry them.
 */
export async function createSetupCheckoutSession(
  params: CreateSetupCheckoutParams
): Promise<{ url: string }> {
  const { scopedDb, teamId, userId, userEmail, successUrl, cancelUrl } = params;

  const stripe = getStripeOrThrow();
  const customerId = await ensureStripeCustomer({
    stripe,
    scopedDb,
    teamId,
    userId,
    userEmail,
  });

  const metadata: Record<string, string> = {
    teamId,
    userId,
    type: SAVE_CARD_METADATA_TYPE,
  };

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: customerId,
    payment_method_types: ['card'],
    metadata,
    setup_intent_data: { metadata },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  captureProductEvent({
    distinctId: userId,
    event: 'welcome_card_setup_opened',
    properties: {
      teamId,
      stripe_checkout_session_id: session.id,
    },
  });

  if (!session.url) {
    throw new Error('Stripe did not return a checkout URL');
  }

  return { url: session.url };
}

export type WelcomeGrantSource =
  | 'setup_checkout'
  | 'setup_intent'
  | 'claim'
  | 'purchase'
  | 'phone';

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

export async function fulfillSavedCard(opts: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  customerId: string;
  paymentMethodId: string;
  source: Exclude<WelcomeGrantSource, 'purchase'>;
}): Promise<{ granted: boolean }> {
  const fingerprint = await cardFingerprint(opts.paymentMethodId);
  const stripe = getStripeOrThrow();
  await stripe.customers.update(opts.customerId, {
    invoice_settings: { default_payment_method: opts.paymentMethodId },
  });
  await opts.scopedDb.billing.saveStripeCustomerId(opts.customerId);
  await opts.scopedDb.billing.clearAutoTopUpFailure();

  return grantWelcomeCreditsForTeam({
    scopedDb: opts.scopedDb,
    teamId: opts.teamId,
    userId: opts.userId,
    source: opts.source,
    fingerprint,
  });
}

/**
 * Stamp the fingerprint first so a grandfathered grant still consumes the
 * PAN. Then pay, or no-op if this team already has the ledger row.
 */
export async function grantWelcomeCreditsForTeam(opts: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  source: WelcomeGrantSource;
  /** Stripe card fingerprint, or the hashed phone number (#1539). */
  fingerprint: string;
}): Promise<{ granted: boolean }> {
  const reserved = await opts.scopedDb.billing.claimWelcomeCardFingerprint(
    opts.fingerprint
  );
  if (!reserved) {
    throw new WelcomeCardAlreadyClaimedError();
  }

  const alreadyGranted = await opts.scopedDb.billing.hasSignupGrant();
  if (alreadyGranted || SIGNUP_GRANT_MICROS <= 0) {
    return { granted: false };
  }

  const result = await grantSignupCredits({
    teamId: opts.teamId,
    addCredits: opts.scopedDb.billing.addCredits,
    alreadyGranted: false,
  });

  if (!result.granted) {
    // Unique-key collision without a readable signupGrant row, or a race
    // the next Stripe retry will see via hasSignupGrant. Do not 200.
    throw new Error('Welcome credit write failed');
  }

  captureProductEvent({
    distinctId: opts.userId,
    event: 'welcome_credits_granted',
    properties: {
      teamId: opts.teamId,
      amount_usd: microsToUsd(SIGNUP_GRANT_MICROS),
      source: opts.source,
    },
  });

  return { granted: true };
}

/** Fingerprint from a PaymentMethod id, then grant. Throws on reuse / write fail. */
export async function grantWelcomeCreditsForPaymentMethod(opts: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  paymentMethodId: string;
  source: WelcomeGrantSource;
}): Promise<{ granted: boolean }> {
  const fingerprint = await cardFingerprint(opts.paymentMethodId);
  return grantWelcomeCreditsForTeam({
    scopedDb: opts.scopedDb,
    teamId: opts.teamId,
    userId: opts.userId,
    source: opts.source,
    fingerprint,
  });
}

export type WelcomeClaimResult = {
  granted: boolean;
  hasCard: boolean;
  hasSignupGrant: boolean;
};

/** Return-from-Stripe safety net (webhook may still be in flight). */
export async function grantWelcomeIfTeamHasCard(opts: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
}): Promise<WelcomeClaimResult> {
  const hasSignupGrant = () => opts.scopedDb.billing.hasSignupGrant();
  const settings = await opts.scopedDb.billing.getBillingSettings();
  if (!settings.stripeCustomerId) {
    return {
      granted: false,
      hasCard: false,
      hasSignupGrant: await hasSignupGrant(),
    };
  }

  const stripe = getStripeOrThrow();
  const methods = await stripe.paymentMethods.list({
    customer: settings.stripeCustomerId,
    type: 'card',
    limit: 1,
  });
  const pm = methods.data[0];
  if (!pm) {
    return {
      granted: false,
      hasCard: false,
      hasSignupGrant: await hasSignupGrant(),
    };
  }

  const { granted } = await fulfillSavedCard({
    scopedDb: opts.scopedDb,
    teamId: opts.teamId,
    userId: opts.userId,
    customerId: settings.stripeCustomerId,
    paymentMethodId: pm.id,
    source: 'claim',
  });
  return {
    granted,
    hasCard: true,
    hasSignupGrant: granted || (await hasSignupGrant()),
  };
}
