/**
 * Stripe Webhook API
 * POST /api/billing/webhook - Handle Stripe webhook events
 */

import { stripeWebhookMiddleware } from '@/functions/stripe-webhook-middleware';
import {
  chargeFingerprint,
  fulfillSavedCard,
  grantWelcomeCreditsForPaymentMethod,
  grantWelcomeCreditsForTeam,
  SAVE_CARD_METADATA_TYPE,
  type WelcomeGrantSource,
} from '@/lib/billing/checkout';
import { SIGNUP_GRANT_MICROS } from '@/lib/billing/constants';
import { isWelcomeCardAlreadyClaimedError } from '@/shared/errors';
import { captureCheckoutAnalyticsForStripeEvent } from '@/lib/billing/checkout-events';
import { microsToDisplayUsd, usdToMicros } from '@/lib/billing/money';
import { getStripeOrThrow } from '@/lib/billing/stripe';
import { getPostHogClient } from '@/lib/posthog-server';
import { createFileRoute } from '@tanstack/react-router';
import { scheduleFlushAnalytics } from '#flush-scheduler';
import type Stripe from 'stripe';
import type { ScopedDb } from '@/lib/db/scoped';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'api', 'billing', 'webhook']);

export const Route = createFileRoute('/api/billing/webhook')({
  server: {
    middleware: [stripeWebhookMiddleware],
    handlers: {
      POST: async ({ context }) => {
        const { stripeEvent: event, scopedDb, teamId, userId } = context;
        if (!event || !scopedDb) {
          return Response.json({ received: true }, { status: 200 });
        }

        try {
          if (teamId && userId) {
            captureCheckoutAnalyticsForStripeEvent(event, {
              teamId,
              userId,
            });
          }

          switch (event.type) {
            case 'checkout.session.completed': {
              const session = event.data.object;

              if (
                session.mode === 'setup' &&
                session.metadata?.type === SAVE_CARD_METADATA_TYPE
              ) {
                if (!teamId || !userId) {
                  throw new Error(
                    'save_card checkout missing teamId or userId'
                  );
                }
                await handleSaveCardCheckout({
                  session,
                  scopedDb,
                  teamId,
                  userId,
                });
                break;
              }

              if (
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                session.metadata?.type !== 'credit_top_up' ||
                session.payment_status !== 'paid'
              ) {
                break;
              }

              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              const amountUsd = parseFloat(session.metadata?.amountUsd ?? '');

              if (isNaN(amountUsd)) {
                logger.error('Invalid metadata:', { data: session.metadata });
                break;
              }

              const customerId = stripeObjectId(session.customer);

              // Save customer ID mapping if not already saved
              if (customerId) {
                await scopedDb.billing.saveStripeCustomerId(customerId);
              }

              if (!session.payment_intent) {
                throw new Error('checkout session missing payment_intent');
              }
              const stripe = getStripeOrThrow();
              const piId = stripeObjectId(session.payment_intent);
              if (!piId) {
                throw new Error('checkout session missing payment_intent');
              }
              const pi = await stripe.paymentIntents.retrieve(piId, {
                expand: ['latest_charge'],
              });
              const charge = pi.latest_charge;
              if (!charge || typeof charge !== 'object') {
                throw new Error('checkout session missing charge');
              }
              const receiptUrl = charge.receipt_url ?? undefined;

              // Default PM / decline-cooldown — not required for the welcome
              // grant. Only a card is reusable: Alipay / WeChat Pay are
              // single-use (#1537), so they are never attached and never
              // become the auto-top-up method.
              if (
                customerId &&
                charge.payment_method_details?.type === 'card'
              ) {
                const purchasePaymentMethodId = stripeObjectId(
                  pi.payment_method
                );
                if (!purchasePaymentMethodId) {
                  throw new Error('checkout session missing payment method');
                }
                try {
                  await stripe.customers.update(customerId, {
                    invoice_settings: {
                      default_payment_method: purchasePaymentMethodId,
                    },
                  });
                  await scopedDb.billing.clearAutoTopUpFailure();
                } catch (err) {
                  logger.error('Failed to set default payment method:', {
                    err,
                  });
                }
              }

              // Add credits (unique stripeSessionId prevents duplicates)
              const amountMicros = usdToMicros(amountUsd);
              const result = await scopedDb.billing.addCredits(amountMicros, {
                stripeSessionId: session.id,
                description: `Top-up: ${microsToDisplayUsd(amountMicros)}`,
                metadata: {
                  stripePaymentIntentId: session.payment_intent,
                  ...(receiptUrl && { receiptUrl }),
                },
              });

              if (result) {
                logger.info(`Added $${amountUsd} credits to team ${teamId}`);
                if (teamId) {
                  const posthog = getPostHogClient();
                  posthog?.capture({
                    distinctId: teamId,
                    event: 'credits_added',
                    properties: {
                      amount_usd: amountUsd,
                      stripe_session_id: session.id,
                      source: 'stripe_webhook',
                    },
                  });
                }
              } else {
                logger.info(`Duplicate session ${session.id}, skipping top-up`);
              }

              // Always attempt: a retry after a credited purchase must still
              // land the welcome grant. 400 unless it landed, already claimed,
              // or this team already has the grant — Stripe will retry.
              if (!teamId || !userId) {
                throw new Error('credit_top_up missing teamId or userId');
              }
              const fingerprint = chargeFingerprint(charge);
              if (!fingerprint) {
                // Nothing to key the one-per-account rule on; the team can
                // still claim by saving a card.
                logger.info('welcome grant skipped: no payment fingerprint', {
                  teamId,
                  paymentMethodType: charge.payment_method_details?.type,
                });
                break;
              }
              await grantWelcomeOrThrow(scopedDb, teamId, () =>
                grantWelcomeCreditsForTeam({
                  scopedDb,
                  teamId,
                  userId,
                  source: 'purchase',
                  fingerprint,
                })
              );
              break;
            }

            case 'setup_intent.succeeded': {
              const setupIntent = event.data.object;
              if (setupIntent.metadata?.type !== SAVE_CARD_METADATA_TYPE) {
                break;
              }
              if (!teamId || !userId) {
                throw new Error(
                  'save_card setup_intent missing teamId or userId'
                );
              }
              const customerId = stripeObjectId(setupIntent.customer);
              const paymentMethodId = stripeObjectId(
                setupIntent.payment_method
              );
              if (!customerId || !paymentMethodId) {
                logger.error('save_card setup_intent missing customer or PM', {
                  teamId,
                  setupIntentId: setupIntent.id,
                });
                throw new Error(
                  'save_card setup_intent missing customer or PM'
                );
              }
              await fulfillSavedCardIgnoringReuse({
                scopedDb,
                teamId,
                userId,
                customerId,
                paymentMethodId,
                source: 'setup_intent',
              });
              break;
            }

            case 'payment_intent.succeeded': {
              const paymentIntent = event.data.object;
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              const type = paymentIntent.metadata?.type;

              if (type === 'auto_top_up') {
                logger.info(
                  `Auto-top-up payment succeeded for team ${paymentIntent.metadata.teamId}`
                );
                break;
              }

              if (type !== 'credit_top_up_direct') break;

              // Reconciles a direct purchase whose in-band grant never landed
              // (the server fn died between charging and crediting). Safe to
              // run on every delivery: addCredits dedupes on idempotencyKey,
              // so the normal case is a no-op.
              const idempotencyKey = paymentIntent.metadata.idempotencyKey;
              const amountUsd = parseFloat(
                paymentIntent.metadata.amountUsd ?? ''
              );
              if (!idempotencyKey || isNaN(amountUsd)) {
                logger.error('Direct top-up intent missing metadata', {
                  teamId,
                  data: paymentIntent.metadata,
                });
                break;
              }

              const amountMicros = usdToMicros(amountUsd);
              const granted = await scopedDb.billing.addCredits(amountMicros, {
                description: `Top-up: ${microsToDisplayUsd(amountMicros)}`,
                idempotencyKey,
                metadata: { stripePaymentIntentId: paymentIntent.id },
              });

              if (granted) {
                logger.warn('Reconciled a direct top-up the server fn missed', {
                  teamId,
                  amountMicros,
                  stripePaymentIntentId: paymentIntent.id,
                });
              }

              if (!teamId || !userId) {
                throw new Error(
                  'credit_top_up_direct missing teamId or userId'
                );
              }
              const pmId = stripeObjectId(paymentIntent.payment_method);
              if (!pmId) {
                throw new Error('credit_top_up_direct missing payment method');
              }
              await grantWelcomeOrThrow(scopedDb, teamId, () =>
                grantWelcomeCreditsForPaymentMethod({
                  scopedDb,
                  teamId,
                  userId,
                  paymentMethodId: pmId,
                  source: 'purchase',
                })
              );
              break;
            }

            default:
              // Ignore other events
              break;
          }

          return Response.json({ received: true }, { status: 200 });
        } catch (error) {
          logger.error('Error:', { err: error });
          return Response.json(
            { error: 'Webhook handler failed' },
            { status: 400 }
          );
        } finally {
          // Server routes skip analyticsFlushMiddleware; without this the
          // checkout_* captures race isolate teardown the same way
          // user_signed_in did on `/api/auth` (#1088).
          await scheduleFlushAnalytics();
        }
      },
    },
  },
});

function stripeObjectId(
  value: string | { id: string } | null | undefined
): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Purchase/setup webhooks 200 on already-claimed so Stripe stops. Anything
 * else that leaves this team without a grant must 400 so Stripe retries.
 */
async function grantWelcomeOrThrow(
  scopedDb: ScopedDb,
  teamId: string,
  grant: () => Promise<{ granted: boolean }>
): Promise<void> {
  try {
    const { granted } = await grant();
    if (granted || SIGNUP_GRANT_MICROS <= 0) return;
    if (await scopedDb.billing.hasSignupGrant()) return;
    throw new Error('Welcome grant did not land');
  } catch (err) {
    if (isWelcomeCardAlreadyClaimedError(err)) {
      logger.info('welcome grant skipped: card already claimed', { teamId });
      return;
    }
    throw err;
  }
}

async function handleSaveCardCheckout(opts: {
  session: Stripe.Checkout.Session;
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
}): Promise<void> {
  const { session, scopedDb, teamId, userId } = opts;
  const customerId = stripeObjectId(session.customer);
  if (!customerId) {
    logger.error('save_card checkout missing customer', {
      teamId,
      sessionId: session.id,
    });
    throw new Error('save_card checkout missing customer');
  }

  const stripe = getStripeOrThrow();
  const setupIntentRef = session.setup_intent;
  const setupIntent =
    typeof setupIntentRef === 'string'
      ? await stripe.setupIntents.retrieve(setupIntentRef)
      : setupIntentRef;
  const paymentMethodId =
    typeof setupIntent?.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id;
  if (!paymentMethodId) {
    logger.error('save_card checkout missing payment method', {
      teamId,
      sessionId: session.id,
    });
    throw new Error('save_card checkout missing payment method');
  }

  await fulfillSavedCardIgnoringReuse({
    scopedDb,
    teamId,
    userId,
    customerId,
    paymentMethodId,
    source: 'setup_checkout',
  });
}

async function fulfillSavedCardIgnoringReuse(opts: {
  scopedDb: ScopedDb;
  teamId: string;
  userId: string;
  customerId: string;
  paymentMethodId: string;
  source: Exclude<WelcomeGrantSource, 'purchase'>;
}): Promise<void> {
  try {
    await fulfillSavedCard(opts);
  } catch (err) {
    if (isWelcomeCardAlreadyClaimedError(err)) {
      logger.info('welcome grant skipped: card already claimed', {
        teamId: opts.teamId,
      });
      return;
    }
    throw err;
  }
}
