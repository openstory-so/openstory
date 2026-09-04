/**
 * Stripe-layer checkout funnel events (#1466).
 *
 * `credits_topup_started` is client-side (intent). These fire when Stripe
 * actually creates a session/PaymentIntent, confirms payment, or fails —
 * so "started but never paid" can be split into never-reached-Stripe /
 * abandoned / declined / 3DS.
 *
 * `credits_added` stays the wallet-ledger event and is not replaced.
 */

import { captureProductEvent } from '@/lib/observability/product-events';
import type Stripe from 'stripe';

type CheckoutMethod = 'checkout' | 'saved_card';

type CheckoutFailureReason =
  | 'abandoned'
  | 'canceled'
  | 'card_declined'
  | '3ds_failed'
  | 'requires_payment_method';

const TOPUP_TYPES = new Set(['credit_top_up', 'credit_top_up_direct']);

const THREE_DS_CODES = new Set([
  'authentication_required',
  'payment_intent_authentication_failure',
]);

const CARD_DECLINED_CODES = new Set([
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'incorrect_number',
  'insufficient_funds',
  'lost_card',
  'stolen_card',
  'generic_decline',
]);

type CheckoutCaptureBase = {
  distinctId: string;
  teamId: string;
  amountUsd: number;
  method: CheckoutMethod;
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  surface?: string;
};

function stripeId(
  value: string | { id: string } | null | undefined
): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.id;
}

function parseAmountUsd(
  metadata: Stripe.Metadata | null | undefined
): number | undefined {
  const raw = metadata?.amountUsd;
  if (!raw) return undefined;
  const n = parseFloat(raw);
  return Number.isNaN(n) ? undefined : n;
}

function checkoutMethodFromType(
  type: string | undefined,
  method: string | undefined
): CheckoutMethod | null {
  if (method === 'checkout' || method === 'saved_card') return method;
  if (type === 'credit_top_up_direct') return 'saved_card';
  if (type === 'credit_top_up') return 'checkout';
  return null;
}

export function mapCheckoutFailureReason(input: {
  eventType?: string;
  paymentIntentStatus?: string | null;
  stripeErrorCode?: string | null;
}): CheckoutFailureReason {
  if (input.eventType === 'checkout.session.expired') return 'abandoned';
  if (
    input.eventType === 'payment_intent.canceled' ||
    input.paymentIntentStatus === 'canceled'
  ) {
    return 'canceled';
  }

  const code = input.stripeErrorCode ?? undefined;
  if (code && THREE_DS_CODES.has(code)) return '3ds_failed';
  if (input.paymentIntentStatus === 'requires_action') return '3ds_failed';
  if (code && CARD_DECLINED_CODES.has(code)) return 'card_declined';
  if (input.paymentIntentStatus === 'requires_payment_method') {
    return 'requires_payment_method';
  }
  if (code) return 'card_declined';
  return 'requires_payment_method';
}

function checkoutProperties(
  input: CheckoutCaptureBase
): Record<string, unknown> {
  return {
    teamId: input.teamId,
    amount_usd: input.amountUsd,
    method: input.method,
    ...(input.stripeCheckoutSessionId
      ? { stripe_checkout_session_id: input.stripeCheckoutSessionId }
      : {}),
    ...(input.stripePaymentIntentId
      ? { stripe_payment_intent_id: input.stripePaymentIntentId }
      : {}),
    ...(input.surface ? { surface: input.surface } : {}),
  };
}

function dedupeKey(event: string, input: CheckoutCaptureBase): string {
  const id =
    input.stripePaymentIntentId ?? input.stripeCheckoutSessionId ?? 'unknown';
  return `${event}:${id}`;
}

export function captureCheckoutOpened(input: CheckoutCaptureBase): void {
  captureProductEvent({
    distinctId: input.distinctId,
    event: 'checkout_opened',
    properties: {
      ...checkoutProperties(input),
      $insert_id: dedupeKey('checkout_opened', input),
    },
  });
}

function captureCheckoutCompleted(input: CheckoutCaptureBase): void {
  captureProductEvent({
    distinctId: input.distinctId,
    event: 'checkout_completed',
    properties: {
      ...checkoutProperties(input),
      $insert_id: dedupeKey('checkout_completed', input),
    },
  });
}

export function captureCheckoutFailed(
  input: CheckoutCaptureBase & {
    reason: CheckoutFailureReason;
    stripeErrorCode?: string | null;
    stripeDeclineCode?: string | null;
  }
): void {
  captureProductEvent({
    distinctId: input.distinctId,
    event: 'checkout_failed',
    properties: {
      ...checkoutProperties(input),
      reason: input.reason,
      ...(input.stripeErrorCode
        ? { stripe_error_code: input.stripeErrorCode }
        : {}),
      ...(input.stripeDeclineCode
        ? { stripe_decline_code: input.stripeDeclineCode }
        : {}),
      $insert_id: dedupeKey('checkout_failed', input),
    },
  });
}

function baseFromMetadata(
  metadata: Stripe.Metadata | null | undefined,
  ctx: { teamId: string; userId: string },
  ids: { sessionId?: string; paymentIntentId?: string }
): CheckoutCaptureBase | null {
  const type = metadata?.type;
  if (!type || !TOPUP_TYPES.has(type)) return null;
  const method = checkoutMethodFromType(type, metadata.method);
  if (!method) return null;
  const amountUsd = parseAmountUsd(metadata);
  if (amountUsd === undefined) return null;
  return {
    distinctId: ctx.userId,
    teamId: ctx.teamId,
    amountUsd,
    method,
    ...(ids.sessionId ? { stripeCheckoutSessionId: ids.sessionId } : {}),
    ...(ids.paymentIntentId
      ? { stripePaymentIntentId: ids.paymentIntentId }
      : {}),
    ...(metadata.surface ? { surface: metadata.surface } : {}),
  };
}

/**
 * Analytics-only: credit grants stay in the webhook handler.
 * Safe to call for every verified Stripe event; unknown types are ignored.
 */
export function captureCheckoutAnalyticsForStripeEvent(
  event: Stripe.Event,
  ctx: { teamId: string; userId: string }
): void {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const base = baseFromMetadata(session.metadata, ctx, {
        sessionId: session.id,
        paymentIntentId: stripeId(session.payment_intent),
      });
      if (!base || session.payment_status !== 'paid') return;
      captureCheckoutCompleted(base);
      return;
    }
    case 'checkout.session.expired': {
      const session = event.data.object;
      const base = baseFromMetadata(session.metadata, ctx, {
        sessionId: session.id,
        paymentIntentId: stripeId(session.payment_intent),
      });
      if (!base || session.payment_status === 'paid') return;
      captureCheckoutFailed({ ...base, reason: 'abandoned' });
      return;
    }
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object;
      const base = baseFromMetadata(paymentIntent.metadata, ctx, {
        paymentIntentId: paymentIntent.id,
      });
      if (!base) return;
      captureCheckoutCompleted(base);
      return;
    }
    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      const base = baseFromMetadata(paymentIntent.metadata, ctx, {
        paymentIntentId: paymentIntent.id,
      });
      if (!base) return;
      const err = paymentIntent.last_payment_error;
      captureCheckoutFailed({
        ...base,
        reason: mapCheckoutFailureReason({
          eventType: event.type,
          paymentIntentStatus: paymentIntent.status,
          stripeErrorCode: err?.code,
        }),
        stripeErrorCode: err?.code,
        stripeDeclineCode: err?.decline_code,
      });
      return;
    }
    case 'payment_intent.canceled': {
      const paymentIntent = event.data.object;
      const base = baseFromMetadata(paymentIntent.metadata, ctx, {
        paymentIntentId: paymentIntent.id,
      });
      if (!base) return;
      captureCheckoutFailed({ ...base, reason: 'canceled' });
      return;
    }
    default:
      return;
  }
}

export function captureCheckoutCanceledFromSession(
  session: {
    id: string;
    payment_status?: string | null;
    payment_intent?: string | { id: string } | null;
    metadata?: Stripe.Metadata | null;
    status?: string | null;
  },
  ctx: { teamId: string; userId: string }
): void {
  if (session.payment_status === 'paid') return;
  if (session.metadata?.teamId && session.metadata.teamId !== ctx.teamId) {
    return;
  }
  const base = baseFromMetadata(session.metadata, ctx, {
    sessionId: session.id,
    paymentIntentId: stripeId(session.payment_intent),
  });
  if (!base) return;
  captureCheckoutFailed({
    ...base,
    reason: session.status === 'expired' ? 'abandoned' : 'canceled',
  });
}

export function captureSavedCardStripeError(
  err: {
    code?: string | null;
    decline_code?: string | null;
    payment_intent?: string | { id: string } | null;
  },
  ctx: {
    distinctId: string;
    teamId: string;
    amountUsd: number;
    surface?: string;
  }
): void {
  const paymentIntentId = stripeId(err.payment_intent);
  const base: CheckoutCaptureBase = {
    distinctId: ctx.distinctId,
    teamId: ctx.teamId,
    amountUsd: ctx.amountUsd,
    method: 'saved_card',
    ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    ...(ctx.surface ? { surface: ctx.surface } : {}),
  };
  if (paymentIntentId) {
    captureCheckoutOpened(base);
  }
  captureCheckoutFailed({
    ...base,
    reason: mapCheckoutFailureReason({
      stripeErrorCode: err.code,
      eventType: 'payment_intent.payment_failed',
    }),
    stripeErrorCode: err.code,
    stripeDeclineCode: err.decline_code,
  });
}
