/**
 * Stripe webhook signature-verification middleware, in its OWN module so the
 * Stripe Node SDK stays out of the client bundle (#1253): `middleware.ts` is
 * pulled into the client module graph by every server fn, and a top-level
 * `stripe` import there shipped a ~212KB chunk to production browsers. Only
 * the webhook API route imports this file.
 */

import { isStripeEnabled } from './constants';
import {
  getStripeOrThrow,
  getStripeWebhookSecret,
} from '@/billing/server/stripe';
import { createScopedDb, type ScopedDb } from '@/platform/server/db/scoped';
import { createMiddleware } from '@tanstack/react-start';
import type Stripe from 'stripe';

export type StripeWebhookContext = {
  stripeEvent: Stripe.Event | null;
  scopedDb: ScopedDb | null;
  organizationId: string | null;
  userId: string | null;
};

/**
 * Stripe webhook signature verification middleware — for use with server routes.
 * Verifies the stripe-signature header and passes the validated event via context.
 * When Stripe is disabled, passes stripeEvent: null so the handler can early-return.
 */
export const stripeWebhookMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    if (!isStripeEnabled()) {
      return next({
        context: {
          stripeEvent: null as Stripe.Event | null,
          scopedDb: null as ScopedDb | null,
          organizationId: null as string | null,
          userId: null as string | null,
        },
      });
    }

    const stripe = getStripeOrThrow();
    const webhookSecret = getStripeWebhookSecret();
    if (!webhookSecret) {
      throw Response.json(
        { error: 'Webhook secret not configured' },
        { status: 500 }
      );
    }

    const body = await request.text();
    const signature = request.headers.get('stripe-signature');
    if (!signature) {
      throw Response.json(
        { error: 'Missing stripe-signature header' },
        { status: 400 }
      );
    }

    try {
      const event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret
      );

      const obj = event.data.object;

      if (
        !('metadata' in obj) ||
        typeof obj.metadata !== 'object' ||
        obj.metadata === null
      ) {
        throw Response.json(
          { error: `Stripe event ${event.id} missing metadata` },
          { status: 400 }
        );
      }
      const metadata = obj.metadata;
      if (!('organizationId' in metadata && 'userId' in metadata)) {
        throw Response.json(
          {
            error: `Stripe event ${event.id} missing organizationId or userId in metadata`,
          },
          { status: 400 }
        );
      }

      const organizationId = metadata.organizationId;
      const userId = metadata.userId;
      if (typeof organizationId !== 'string' || typeof userId !== 'string') {
        throw Response.json(
          {
            error: `Stripe event ${event.id} missing organizationId or userId in metadata`,
          },
          { status: 400 }
        );
      }
      return next({
        context: {
          stripeEvent: event,
          scopedDb: createScopedDb(organizationId, userId),
          organizationId,
          userId,
        },
      });
    } catch (error) {
      // Metadata validation throws Response above; rethrow as-is. Anything
      // else (signature verify failure, malformed body) is an invalid webhook.
      if (error instanceof Response) throw error;
      throw Response.json({ error: 'Invalid signature' }, { status: 400 });
    }
  }
);
