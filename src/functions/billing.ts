/**
 * Billing Server Functions
 * Balance, checkout, transactions, and auto-top-up
 */

import { requireTeamAdminAccess } from '@/lib/auth/action-utils';
import { createCheckoutSession } from '@/lib/billing/checkout';
import {
  isStripeEnabled,
  MAX_TOPUP_AMOUNT_USD,
  MIN_TOPUP_AMOUNT_USD,
  totalCheckoutCents,
} from '@/lib/billing/constants';
import {
  micros,
  microsToDisplayUsd,
  microsToUsd,
  usdToMicros,
} from '@/lib/billing/money';
import type { TransactionType } from '@/lib/db/schema/credits';
import { ValidationError } from '@/lib/errors';
import { FOUNDER_EMAIL } from '@/lib/marketing/constants';
import { getLogger } from '@/lib/observability/logger';
import { captureProductEvent } from '@/lib/observability/product-events';
import { sendFounderCreditRequestEmail } from '@/lib/services/email-service';
import { getServerAppUrl } from '@/lib/utils/environment';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import Stripe from 'stripe';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const logger = getLogger(['openstory', 'functions', 'billing']);

const checkoutInputSchema = z.object({
  amountUsd: z.number().min(MIN_TOPUP_AMOUNT_USD).max(MAX_TOPUP_AMOUNT_USD),
});

export const createCheckoutSessionFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(checkoutInputSchema))
  .handler(async ({ data, context }) => {
    if (!isStripeEnabled()) {
      throw new ValidationError('Stripe is not configured');
    }

    const req = getRequest();
    const appUrl = getServerAppUrl(req);

    const { url } = await createCheckoutSession({
      scopedDb: context.scopedDb,
      teamId: context.teamId,
      amountUsd: data.amountUsd,
      userId: context.user.id,
      userEmail: context.user.email,
      successUrl: `${appUrl}/credits?success=true`,
      cancelUrl: `${appUrl}/credits?canceled=true`,
    });

    return { url };
  });

// ============================================================================
// Payment methods + direct purchase (#1099)
// ============================================================================

export type SavedPaymentMethod = {
  id: string;
  brand: string;
  last4: string;
  isDefault: boolean;
};

/**
 * Saved cards for the team's Stripe customer. Cards get saved during
 * Stripe Checkout (`setup_future_usage: 'off_session'`), so a team that has
 * never checked out has none — the add-credits dialog then falls back to a
 * Checkout redirect.
 *
 * Admin-only: these cards belong to whoever set billing up, and
 * `purchaseCreditsFn` can charge them without further consent.
 */
export const listPaymentMethodsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(
    async ({ context }): Promise<{ paymentMethods: SavedPaymentMethod[] }> => {
      if (!isStripeEnabled()) return { paymentMethods: [] };

      await requireTeamAdminAccess(context.user.id, context.teamId);

      const settings = await context.scopedDb.billing.getBillingSettings();
      if (!settings.stripeCustomerId) return { paymentMethods: [] };

      // Dynamic import — keeps the Stripe Node SDK out of the client bundle (#1253).
      const { getStripeOrThrow } = await import('@/lib/billing/stripe');
      const stripe = getStripeOrThrow();
      const [customer, methods] = await Promise.all([
        stripe.customers.retrieve(settings.stripeCustomerId),
        stripe.paymentMethods.list({
          customer: settings.stripeCustomerId,
          type: 'card',
          limit: 10,
        }),
      ]);

      const defaultPm = customer.deleted
        ? null
        : customer.invoice_settings.default_payment_method;
      const defaultPmId =
        typeof defaultPm === 'string' ? defaultPm : defaultPm?.id;

      // Drop cardless rows rather than inventing brand/last4 for them — a
      // blank "Visa •••• " is still selectable and still chargeable.
      const paymentMethods = methods.data
        .flatMap((pm) =>
          pm.card
            ? [
                {
                  id: pm.id,
                  brand: pm.card.brand,
                  last4: pm.card.last4,
                  isDefault: pm.id === defaultPmId,
                },
              ]
            : []
        )
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

      return { paymentMethods };
    }
  );

const purchaseInputSchema = z.object({
  amountUsd: z.number().min(MIN_TOPUP_AMOUNT_USD).max(MAX_TOPUP_AMOUNT_USD),
  paymentMethodId: z.string().min(1),
  /**
   * Client-generated, stable for the lifetime of one "Continue" press. Keys
   * both the Stripe charge and the wallet credit so a retry — ours, the
   * user's, or the transport's — can never charge or credit twice.
   */
  requestId: z.string().min(1).max(64),
});

/**
 * Charge a saved card off-session and credit the wallet immediately —
 * the in-app "Continue" path of the add-credits dialog (#1099). New cards
 * still go through Stripe Checkout (which saves them for next time).
 */
export const purchaseCreditsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(purchaseInputSchema))
  .handler(async ({ data, context }) => {
    if (!isStripeEnabled()) {
      throw new ValidationError('Stripe is not configured');
    }

    await requireTeamAdminAccess(context.user.id, context.teamId);

    const settings = await context.scopedDb.billing.getBillingSettings();
    if (!settings.stripeCustomerId) {
      throw new ValidationError(
        'No saved payment method — add one to continue'
      );
    }

    // Dynamic import — keeps the Stripe Node SDK out of the client bundle (#1253).
    const { getStripeOrThrow } = await import('@/lib/billing/stripe');
    const stripe = getStripeOrThrow();
    const paymentMethod = await stripe.paymentMethods.retrieve(
      data.paymentMethodId
    );
    const pmCustomerId =
      typeof paymentMethod.customer === 'string'
        ? paymentMethod.customer
        : paymentMethod.customer?.id;
    if (pmCustomerId !== settings.stripeCustomerId) {
      throw new ValidationError('Payment method not found');
    }

    const amountMicros = usdToMicros(data.amountUsd);
    const idempotencyKey = `purchase:${context.teamId}:${data.requestId}`;

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: totalCheckoutCents(amountMicros),
          currency: 'usd',
          customer: settings.stripeCustomerId,
          payment_method: data.paymentMethodId,
          off_session: true,
          confirm: true,
          expand: ['latest_charge'],
          // userId is required by stripeWebhookMiddleware — without it the
          // reconciling payment_intent.succeeded webhook is rejected with 400.
          metadata: {
            teamId: context.teamId,
            userId: context.user.id,
            type: 'credit_top_up_direct',
            amountUsd: String(data.amountUsd),
            idempotencyKey,
          },
        },
        { idempotencyKey }
      );
    } catch (err) {
      // ONLY a declined card is the user's problem. An invalid API key, a
      // Stripe outage, or a bug of ours must stay a 5xx — relabelling it 400
      // both misinforms the user and (via the log-level split in
      // loggerMiddleware) hides a payment outage from production error logs.
      if (err instanceof Stripe.errors.StripeCardError) {
        throw new ValidationError(err.message);
      }
      throw err;
    }

    if (paymentIntent.status !== 'succeeded') {
      // `processing` / `requires_capture` will likely settle, so telling the
      // user it failed would be wrong — when they do, payment_intent.succeeded
      // fires and the webhook grants the credits.
      logger.warn('Direct purchase intent not immediately successful', {
        teamId: context.teamId,
        status: paymentIntent.status,
        stripePaymentIntentId: paymentIntent.id,
      });
      throw new ValidationError(
        paymentIntent.status === 'requires_action'
          ? 'Your card requires additional verification — use "Add payment method" to pay via checkout instead'
          : 'Your payment is still processing — your credits will appear shortly'
      );
    }

    const charge = paymentIntent.latest_charge;
    const receiptUrl =
      charge && typeof charge === 'object'
        ? (charge.receipt_url ?? undefined)
        : undefined;

    let result;
    try {
      result = await context.scopedDb.billing.addCredits(amountMicros, {
        description: `Top-up: ${microsToDisplayUsd(amountMicros)}`,
        idempotencyKey,
        metadata: {
          stripePaymentIntentId: paymentIntent.id,
          ...(receiptUrl && { receiptUrl }),
        },
      });
    } catch (err) {
      // The card is already charged. Everything needed to reconcile by hand
      // goes in this log; the webhook retries the grant with the same key.
      logger.error('Charged the customer but failed to credit the wallet', {
        teamId: context.teamId,
        userId: context.user.id,
        amountMicros,
        idempotencyKey,
        stripePaymentIntentId: paymentIntent.id,
        err,
      });
      throw err;
    }

    captureProductEvent({
      distinctId: context.user.id,
      event: 'credits_added',
      properties: {
        teamId: context.teamId,
        amount_usd: data.amountUsd,
        stripe_payment_intent_id: paymentIntent.id,
        source: 'direct_purchase',
      },
    });

    // `null` means this exact grant already landed (replayed request) — the
    // earlier credit stands, so report the balance rather than a phantom.
    return {
      success: true,
      balance: microsToUsd(
        result?.newBalance ?? (await context.scopedDb.billing.getBalance())
      ),
    };
  });

// ============================================================================
// Balance
// ============================================================================

export const getBillingBalanceFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb } = context;

    const [funds, settings, usageHistory] = await Promise.all([
      scopedDb.billing.getAvailable(),
      scopedDb.billing.getBillingSettings(),
      // One credit_usage row is enough — drives welcome-credits suppression (#1096).
      scopedDb.billing.getTransactionHistory({
        limit: 1,
        type: 'credit_usage',
      }),
    ]);

    return {
      teamId: context.teamId,
      balance: microsToUsd(funds.balance),
      availableUsd: microsToUsd(funds.available),
      reservedUsd: microsToUsd(funds.reserved),
      stripeEnabled: isStripeEnabled(),
      // D1 `count(*)` can arrive as a string — coerce. Prefer row presence too.
      hasUsedCredits:
        usageHistory.transactions.length > 0 || Number(usageHistory.total) > 0,
      autoTopUp: {
        enabled: settings.autoTopUpEnabled,
        thresholdUsd: settings.autoTopUpThresholdMicros
          ? microsToUsd(micros(settings.autoTopUpThresholdMicros))
          : null,
        amountUsd: settings.autoTopUpAmountMicros
          ? microsToUsd(micros(settings.autoTopUpAmountMicros))
          : null,
        lastFailure: settings.autoTopUpFailedAt
          ? { at: new Date(settings.autoTopUpFailedAt).toISOString() }
          : null,
      },
      hasPaymentMethod: !!settings.stripeCustomerId,
    };
  });

// ============================================================================
// Founder credit request ("Ask Tom for Credits", #1096)
// ============================================================================

const founderCreditsInputSchema = z.object({
  message: z.string().trim().max(2000).optional(),
});

export const requestFounderCreditsFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(founderCreditsInputSchema))
  .handler(async ({ data, context }) => {
    const balance = await context.scopedDb.billing.getBalance();
    const balanceDisplay = microsToDisplayUsd(balance);
    const message = data.message || undefined;

    const result = await sendFounderCreditRequestEmail({
      to: FOUNDER_EMAIL,
      userName: context.user.name,
      userEmail: context.user.email,
      teamId: context.teamId,
      balanceDisplay,
      message,
    });

    // Fired regardless of email outcome — the PostHog → Slack alert (#1088)
    // is the backup channel when email delivery fails.
    captureProductEvent({
      distinctId: context.user.id,
      event: 'founder_credits_requested',
      properties: {
        teamId: context.teamId,
        userEmail: context.user.email,
        balance: balanceDisplay,
        emailSent: result.success,
        hasMessage: !!message,
      },
    });

    if (!result.success) {
      throw new ValidationError(
        `Couldn't send your request — email ${FOUNDER_EMAIL} directly.`
      );
    }

    return { success: true };
  });

// ============================================================================
// Transactions
// ============================================================================

const VALID_TRANSACTION_TYPES: readonly TransactionType[] = [
  'credit_purchase',
  'credit_usage',
  'credit_adjustment',
  'credit_refund',
];

function isTransactionType(value: string): value is TransactionType {
  return (VALID_TRANSACTION_TYPES as readonly string[]).includes(value);
}

const transactionsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  type: z.string().optional(),
});

type TransactionMetadata = { receiptUrl?: string } | null;

function parseTransactionMetadata(raw: unknown): TransactionMetadata {
  if (raw == null || typeof raw !== 'object') return null;
  const obj = raw;
  return {
    ...('receiptUrl' in obj &&
      typeof obj.receiptUrl === 'string' && { receiptUrl: obj.receiptUrl }),
  };
}

type Transaction = {
  id: string;
  type: string;
  amount: number;
  balanceAfter: number;
  description: string | null;
  metadata: TransactionMetadata;
  createdAt: Date;
};

export const getTransactionsFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(transactionsInputSchema))
  .handler(
    async ({
      data,
      context,
    }): Promise<{
      transactions: Transaction[];
      total: number;
    }> => {
      const type =
        data.type && isTransactionType(data.type) ? data.type : undefined;

      const result = await context.scopedDb.billing.getTransactionHistory({
        limit: data.limit,
        offset: data.offset,
        ...(type && { type }),
      });

      const transactions = result.transactions.map((tx) => ({
        ...tx,
        amount: microsToUsd(micros(tx.amount)),
        balanceAfter: microsToUsd(micros(tx.balanceAfter)),
        metadata: parseTransactionMetadata(tx.metadata),
      }));

      return { transactions, total: result.total };
    }
  );

// ============================================================================
// Auto Top-Up
// ============================================================================

// Bounded like the interactive purchase paths: `amountUsd` drives an
// unattended off-session charge, so it is the LAST place to trust the client.
const autoTopUpInputSchema = z.object({
  enabled: z.boolean(),
  thresholdUsd: z.number().min(0).max(MAX_TOPUP_AMOUNT_USD).optional(),
  amountUsd: z
    .number()
    .min(MIN_TOPUP_AMOUNT_USD)
    .max(MAX_TOPUP_AMOUNT_USD)
    .optional(),
});

export const updateAutoTopUpFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(autoTopUpInputSchema))
  .handler(async ({ data, context }) => {
    if (!isStripeEnabled()) {
      throw new ValidationError('Stripe is not configured');
    }

    await requireTeamAdminAccess(context.user.id, context.teamId);

    const billingSettings = await context.scopedDb.billing.getBillingSettings();

    if (!billingSettings.stripeCustomerId) {
      throw new ValidationError(
        'Add a payment method first by making a top-up purchase'
      );
    }

    await context.scopedDb.billing.updateAutoTopUpSettings({
      enabled: data.enabled,
      thresholdMicros:
        data.thresholdUsd !== undefined
          ? usdToMicros(data.thresholdUsd)
          : undefined,
      amountMicros:
        data.amountUsd !== undefined ? usdToMicros(data.amountUsd) : undefined,
    });

    return {
      message: data.enabled ? 'Auto top-up enabled' : 'Auto top-up disabled',
    };
  });
