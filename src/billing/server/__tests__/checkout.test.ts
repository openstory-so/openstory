import type { ScopedDb } from '@/platform/server/db/scoped';
import { describe, expect, it, vi } from 'vitest';

const create = vi.fn();
vi.doMock('@/billing/server/stripe', () => ({
  getStripeOrThrow: () => ({
    customers: {
      retrieve: vi.fn().mockResolvedValue({ deleted: false }),
      create: vi.fn().mockResolvedValue({ id: 'cus_new' }),
      update: vi.fn(),
    },
    checkout: {
      sessions: { create },
    },
  }),
}));

const captureProductEvent = vi.fn();
vi.doMock('@/platform/server/observability/product-events', () => ({
  captureProductEvent,
}));

const { createCheckoutSession, createSetupCheckoutSession } =
  await import('@/billing/server/checkout');

function makeScopedDb() {
  const stub = {
    billing: {
      getBillingSettings: vi
        .fn()
        .mockResolvedValue({ stripeCustomerId: 'cus_1' }),
      saveStripeCustomerId: vi.fn(),
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub
  return stub as unknown as ScopedDb;
}

describe('createCheckoutSession', () => {
  it('charges credit + fee line items but metadata stores credit-only amountUsd', async () => {
    create.mockResolvedValue({
      id: 'cs_1',
      url: 'https://checkout.stripe.com/test',
      payment_intent: 'pi_1',
    });
    captureProductEvent.mockClear();

    await createCheckoutSession({
      scopedDb: makeScopedDb(),
      teamId: 'team_1',
      amountUsd: 100,
      userId: 'user_1',
      userEmail: 'test@example.com',
      successUrl: 'https://app/success',
      cancelUrl: 'https://app/cancel',
      surface: 'sidebar_pill',
    });

    expect(create).toHaveBeenCalledTimes(1);
    const session = create.mock.calls[0]?.[0];
    expect(session.line_items).toEqual([
      expect.objectContaining({
        price_data: expect.objectContaining({ unit_amount: 10_000 }),
      }),
      expect.objectContaining({
        // 7% platform fee on $100 credits → $7.00
        price_data: expect.objectContaining({ unit_amount: 700 }),
      }),
    ]);
    expect(session.metadata).toMatchObject({
      amountUsd: '100',
      type: 'credit_top_up',
      method: 'checkout',
      surface: 'sidebar_pill',
    });
    expect(session.payment_intent_data.metadata).toEqual(session.metadata);
    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'checkout_opened',
      properties: expect.objectContaining({
        teamId: 'team_1',
        amount_usd: 100,
        method: 'checkout',
        stripe_checkout_session_id: 'cs_1',
        stripe_payment_intent_id: 'pi_1',
        surface: 'sidebar_pill',
      }),
    });
  });

  it('lets the Dashboard pick payment methods and saves only cards (#1537)', async () => {
    create.mockResolvedValue({
      id: 'cs_2',
      url: 'https://x',
      payment_intent: 'pi_2',
    });
    await createCheckoutSession({
      scopedDb: makeScopedDb(),
      teamId: 'team_1',
      amountUsd: 10,
      userId: 'user_1',
      userEmail: 'test@example.com',
      successUrl: 'https://app/success',
      cancelUrl: 'https://app/cancel',
    });
    const session = create.mock.calls.at(-1)?.[0];
    // A hard-coded list would 400 the whole checkout when a wallet is off.
    expect(session.payment_method_types).toBeUndefined();
    // Session-level setup_future_usage hides single-use wallets.
    expect(session.payment_intent_data.setup_future_usage).toBeUndefined();
    expect(session.payment_method_options).toEqual({
      card: { setup_future_usage: 'off_session' },
      wechat_pay: { client: 'web' },
    });
  });

  it('saves a card with Checkout setup mode and no charge', async () => {
    create.mockReset();
    create.mockResolvedValue({
      id: 'cs_setup',
      url: 'https://checkout.stripe.com/setup',
    });

    await createSetupCheckoutSession({
      scopedDb: makeScopedDb(),
      teamId: 'team_1',
      userId: 'user_1',
      userEmail: 'test@example.com',
      successUrl: 'https://app/credits',
      cancelUrl: 'https://app/credits',
    });

    const session = create.mock.calls[0]?.[0];
    expect(session.mode).toBe('setup');
    expect(session.line_items).toBeUndefined();
    expect(session.metadata).toEqual({
      teamId: 'team_1',
      userId: 'user_1',
      type: 'save_card',
    });
    expect(session.setup_intent_data.metadata).toEqual(session.metadata);
  });
});
