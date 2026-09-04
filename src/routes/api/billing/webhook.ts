/**
 * Stripe Webhook API
 * POST /api/billing/webhook - Handle Stripe webhook events
 */

import { stripeWebhookMiddleware } from '@/functions/stripe-webhook-middleware';
import { captureCheckoutAnalyticsForStripeEvent } from '@/lib/billing/checkout-events';
import { microsToDisplayUsd, usdToMicros } from '@/lib/billing/money';
import { getStripeOrThrow } from '@/lib/billing/stripe';
import { getPostHogClient } from '@/lib/posthog-server';
import { createFileRoute } from '@tanstack/react-router';
import { scheduleFlushAnalytics } from '#flush-scheduler';

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

              // Retrieve receipt URL + set default payment method (best-effort)
              const customerId = session.customer
                ? typeof session.customer === 'string'
                  ? session.customer
                  : session.customer.id
                : undefined;

              // Save customer ID mapping if not already saved
              if (customerId) {
                await scopedDb.billing.saveStripeCustomerId(customerId);
              }
              let receiptUrl: string | undefined;
              try {
                if (session.payment_intent) {
                  const stripe = getStripeOrThrow();
                  const piId =
                    typeof session.payment_intent === 'string'
                      ? session.payment_intent
                      : session.payment_intent.id;
                  const pi = await stripe.paymentIntents.retrieve(piId, {
                    expand: ['latest_charge'],
                  });
                  const charge = pi.latest_charge;
                  if (charge && typeof charge === 'object') {
                    receiptUrl = charge.receipt_url ?? undefined;
                  }

                  // Set as default payment method so auto-top-up can charge off-session
                  if (pi.payment_method && customerId) {
                    const pmId =
                      typeof pi.payment_method === 'string'
                        ? pi.payment_method
                        : pi.payment_method.id;
                    await stripe.customers.update(customerId, {
                      invoice_settings: { default_payment_method: pmId },
                    });
                    // New default card — lift the decline cooldown so the
                    // next reservation can auto-top-up instead of waiting
                    // AUTO_TOPUP_DECLINE_COOLDOWN_MS (#1334).
                    await scopedDb.billing.clearAutoTopUpFailure();
                  }
                }
              } catch (err) {
                logger.error('Failed to fetch receipt URL:', { err });
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

              if (!result) {
                logger.info(`Duplicate session ${session.id}, skipping`);
                break;
              }

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
