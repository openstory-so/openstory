/**
 * Stripe Webhook API
 * POST /api/billing/webhook - Handle Stripe webhook events
 */

import { stripeWebhookMiddleware } from '@/billing/stripe-webhook-middleware.fn';
import {
  SAVE_CARD_METADATA_TYPE,
  saveCardFromCheckout,
} from '@/billing/server/checkout';
import { captureCheckoutAnalyticsForStripeEvent } from '@/billing/server/checkout-events';
import { microsToDisplayUsd, usdToMicros } from '@/billing/money';
import { getStripeOrThrow } from '@/billing/server/stripe';
import { getPostHogClient } from '@/platform/server/observability/posthog-server';
import { createFileRoute } from '@tanstack/react-router';
import { scheduleFlushAnalytics } from '#flush-scheduler';

import { getLogger } from '@/platform/logger';

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
                await saveCardFromCheckout(session, scopedDb);
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

              // Default PM / decline-cooldown. Only a card is reusable: Alipay / WeChat Pay are
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
