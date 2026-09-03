import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';

const captureProductEvent = vi.fn();
vi.doMock('@/lib/observability/product-events', () => ({
  captureProductEvent,
}));

const {
  captureCheckoutAnalyticsForStripeEvent,
  captureCheckoutCanceledFromSession,
  captureCheckoutOpened,
  captureSavedCardStripeError,
  mapCheckoutFailureReason,
} = await import('./checkout-events');

const CTX = { teamId: 'team_1', userId: 'user_1' };

function stripeEvent(
  type: Stripe.Event['type'],
  object: Record<string, unknown>
): Stripe.Event {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Stripe.Event is a 260-member union; tests only need type + data.object
  return {
    id: 'evt_1',
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

function lastCapture() {
  return captureProductEvent.mock.calls.at(-1)?.[0];
}

describe('mapCheckoutFailureReason', () => {
  it('maps Stripe failure signals onto the reason enum', () => {
    expect(
      mapCheckoutFailureReason({ eventType: 'checkout.session.expired' })
    ).toBe('abandoned');
    expect(
      mapCheckoutFailureReason({ eventType: 'payment_intent.canceled' })
    ).toBe('canceled');
    expect(
      mapCheckoutFailureReason({ paymentIntentStatus: 'requires_action' })
    ).toBe('3ds_failed');
    expect(
      mapCheckoutFailureReason({
        stripeErrorCode: 'authentication_required',
      })
    ).toBe('3ds_failed');
    expect(mapCheckoutFailureReason({ stripeErrorCode: 'card_declined' })).toBe(
      'card_declined'
    );
    expect(
      mapCheckoutFailureReason({
        paymentIntentStatus: 'requires_payment_method',
      })
    ).toBe('requires_payment_method');
  });
});

describe('captureCheckoutOpened', () => {
  it('captures Stripe IDs, amount, method, teamId, and surface', () => {
    captureProductEvent.mockClear();
    captureCheckoutOpened({
      distinctId: 'user_1',
      teamId: 'team_1',
      amountUsd: 25,
      method: 'checkout',
      stripeCheckoutSessionId: 'cs_1',
      stripePaymentIntentId: 'pi_1',
      surface: 'sidebar_pill',
    });
    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'checkout_opened',
      properties: {
        teamId: 'team_1',
        amount_usd: 25,
        method: 'checkout',
        stripe_checkout_session_id: 'cs_1',
        stripe_payment_intent_id: 'pi_1',
        surface: 'sidebar_pill',
        $insert_id: 'checkout_opened:pi_1',
      },
    });
  });
});

describe('captureCheckoutAnalyticsForStripeEvent', () => {
  it('fires checkout_completed on a paid checkout session', () => {
    captureProductEvent.mockClear();
    captureCheckoutAnalyticsForStripeEvent(
      stripeEvent('checkout.session.completed', {
        id: 'cs_1',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        metadata: {
          type: 'credit_top_up',
          method: 'checkout',
          amountUsd: '10',
          surface: 'pricing',
        },
      }),
      CTX
    );
    expect(lastCapture()).toEqual({
      distinctId: 'user_1',
      event: 'checkout_completed',
      properties: {
        teamId: 'team_1',
        amount_usd: 10,
        method: 'checkout',
        stripe_checkout_session_id: 'cs_1',
        stripe_payment_intent_id: 'pi_1',
        surface: 'pricing',
        $insert_id: 'checkout_completed:pi_1',
      },
    });
  });

  it('dedupes session.completed and payment_intent.succeeded via $insert_id', () => {
    captureProductEvent.mockClear();
    captureCheckoutAnalyticsForStripeEvent(
      stripeEvent('checkout.session.completed', {
        id: 'cs_1',
        payment_status: 'paid',
        payment_intent: 'pi_1',
        metadata: {
          type: 'credit_top_up',
          amountUsd: '10',
        },
      }),
      CTX
    );
    captureCheckoutAnalyticsForStripeEvent(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_1',
        metadata: {
          type: 'credit_top_up',
          amountUsd: '10',
        },
      }),
      CTX
    );
    const insertIds = captureProductEvent.mock.calls.map(
      (call) => call[0].properties.$insert_id
    );
    expect(insertIds).toEqual([
      'checkout_completed:pi_1',
      'checkout_completed:pi_1',
    ]);
  });

  it('fires checkout_failed abandoned when a session expires unpaid', () => {
    captureProductEvent.mockClear();
    captureCheckoutAnalyticsForStripeEvent(
      stripeEvent('checkout.session.expired', {
        id: 'cs_1',
        payment_status: 'unpaid',
        payment_intent: 'pi_1',
        metadata: {
          type: 'credit_top_up',
          amountUsd: '10',
        },
      }),
      CTX
    );
    expect(lastCapture()).toMatchObject({
      event: 'checkout_failed',
      properties: {
        reason: 'abandoned',
        stripe_checkout_session_id: 'cs_1',
        stripe_payment_intent_id: 'pi_1',
      },
    });
  });

  it('maps payment_intent.payment_failed card declines', () => {
    captureProductEvent.mockClear();
    captureCheckoutAnalyticsForStripeEvent(
      stripeEvent('payment_intent.payment_failed', {
        id: 'pi_1',
        status: 'requires_payment_method',
        last_payment_error: {
          code: 'card_declined',
          decline_code: 'insufficient_funds',
        },
        metadata: {
          type: 'credit_top_up_direct',
          amountUsd: '10',
          surface: 'billing_gate',
        },
      }),
      CTX
    );
    expect(lastCapture()).toEqual({
      distinctId: 'user_1',
      event: 'checkout_failed',
      properties: {
        teamId: 'team_1',
        amount_usd: 10,
        method: 'saved_card',
        stripe_payment_intent_id: 'pi_1',
        surface: 'billing_gate',
        reason: 'card_declined',
        stripe_error_code: 'card_declined',
        stripe_decline_code: 'insufficient_funds',
        $insert_id: 'checkout_failed:pi_1',
      },
    });
  });

  it('ignores auto-top-up and unpaid checkout completions', () => {
    captureProductEvent.mockClear();
    captureCheckoutAnalyticsForStripeEvent(
      stripeEvent('payment_intent.succeeded', {
        id: 'pi_auto',
        metadata: { type: 'auto_top_up', amountUsd: '10' },
      }),
      CTX
    );
    captureCheckoutAnalyticsForStripeEvent(
      stripeEvent('checkout.session.completed', {
        id: 'cs_unpaid',
        payment_status: 'unpaid',
        metadata: { type: 'credit_top_up', amountUsd: '10' },
      }),
      CTX
    );
    expect(captureProductEvent).not.toHaveBeenCalled();
  });
});

describe('captureCheckoutCanceledFromSession', () => {
  it('fires canceled on the Stripe cancel return URL', () => {
    captureProductEvent.mockClear();
    captureCheckoutCanceledFromSession(
      {
        id: 'cs_1',
        payment_status: 'unpaid',
        payment_intent: 'pi_1',
        status: 'open',
        metadata: {
          type: 'credit_top_up',
          teamId: 'team_1',
          amountUsd: '15',
        },
      },
      CTX
    );
    expect(lastCapture()).toMatchObject({
      event: 'checkout_failed',
      properties: {
        reason: 'canceled',
        amount_usd: 15,
        stripe_checkout_session_id: 'cs_1',
      },
    });
  });

  it('does not fire when the session already paid or belongs to another team', () => {
    captureProductEvent.mockClear();
    captureCheckoutCanceledFromSession(
      {
        id: 'cs_paid',
        payment_status: 'paid',
        metadata: {
          type: 'credit_top_up',
          teamId: 'team_1',
          amountUsd: '10',
        },
      },
      CTX
    );
    captureCheckoutCanceledFromSession(
      {
        id: 'cs_other',
        payment_status: 'unpaid',
        metadata: {
          type: 'credit_top_up',
          teamId: 'team_other',
          amountUsd: '10',
        },
      },
      CTX
    );
    expect(captureProductEvent).not.toHaveBeenCalled();
  });
});

describe('captureSavedCardStripeError', () => {
  it('opens and fails a saved-card attempt that Stripe declined', () => {
    captureProductEvent.mockClear();
    captureSavedCardStripeError(
      {
        code: 'card_declined',
        decline_code: 'generic_decline',
        payment_intent: 'pi_1',
      },
      {
        distinctId: 'user_1',
        teamId: 'team_1',
        amountUsd: 10,
        surface: 'welcome_dialog',
      }
    );
    expect(captureProductEvent).toHaveBeenCalledTimes(2);
    expect(captureProductEvent.mock.calls[0]?.[0].event).toBe(
      'checkout_opened'
    );
    expect(captureProductEvent.mock.calls[1]?.[0]).toMatchObject({
      event: 'checkout_failed',
      properties: {
        method: 'saved_card',
        reason: 'card_declined',
        stripe_error_code: 'card_declined',
        stripe_decline_code: 'generic_decline',
        surface: 'welcome_dialog',
      },
    });
  });
});
