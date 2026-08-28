/**
 * Auto-top-up: when the balance falls to the threshold, charge the saved card
 * off-session for a flat configured amount and credit it (#1099).
 */

import { micros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  creditReservations,
  credits,
  teamBillingSettings,
  teams,
  transactions,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as realConstants from '@/lib/billing/constants';
import { AUTO_TOPUP_DECLINE_COOLDOWN_MS } from '@/lib/billing/constants';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const paymentIntentCreate = vi.fn();
const customersRetrieve = vi.fn();
const loggerError = vi.fn();
const loggerDebug = vi.fn();
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();

vi.doMock('@/lib/billing/constants', () => ({
  ...realConstants,
  isStripeEnabled: () => true,
}));

vi.doMock('@/lib/observability/logger', () => ({
  getLogger: () => ({
    error: loggerError,
    debug: loggerDebug,
    info: loggerInfo,
    warn: loggerWarn,
  }),
}));

vi.doMock('@/lib/billing/stripe', () => ({
  getStripeOrThrow: () => ({
    customers: {
      retrieve: customersRetrieve,
    },
    paymentIntents: { create: paymentIntentCreate },
  }),
}));

const { createBillingMethods } = await import('./billing');

function cardDeclinedError(declineCode = 'insufficient_funds') {
  return Object.assign(new Error('Your card was declined.'), {
    type: 'StripeCardError',
    code: 'card_declined',
    decline_code: declineCode,
  });
}

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  customersRetrieve.mockResolvedValue({
    deleted: false,
    invoice_settings: { default_payment_method: 'pm_1' },
  });
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(teamBillingSettings);
  await db.delete(credits);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
});

async function seedSettings(overrides: {
  balance: number;
  thresholdMicros: number | null;
  amountMicros?: number;
}) {
  await db.insert(credits).values({ teamId, balance: overrides.balance });
  await db.insert(teamBillingSettings).values({
    teamId,
    stripeCustomerId: 'cus_1',
    autoTopUpEnabled: true,
    autoTopUpThresholdMicros: overrides.thresholdMicros,
    autoTopUpAmountMicros: overrides.amountMicros ?? 100_000_000,
  });
}

function balanceOf() {
  return db
    .select({ balance: credits.balance })
    .from(credits)
    .where(eq(credits.teamId, teamId))
    .then(([row]) => row?.balance);
}

function settingsOf() {
  return db
    .select()
    .from(teamBillingSettings)
    .where(eq(teamBillingSettings.teamId, teamId))
    .then(([row]) => row);
}

describe('maybeAutoTopUp', () => {
  it('charges the configured amount and credits it', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      latest_charge: { receipt_url: 'https://receipt' },
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    // $100 credited + 7% fee → $107.00 charged
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(paymentIntentCreate.mock.calls[0]?.[0]).toMatchObject({
      amount: 10_700,
      customer: 'cus_1',
      payment_method: 'pm_1',
      off_session: true,
    });

    expect(await balanceOf()).toBe(103_000_000); // $3 + $100
  });

  it('does not charge when the balance is above the threshold', async () => {
    await seedSettings({ balance: 50_000_000, thresholdMicros: 5_000_000 });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).not.toHaveBeenCalled();
  });

  it('charges when available funds are below the threshold even if posted is not', async () => {
    // Posted $6, $5 held → available $1, threshold $5. Auto-top-up used to
    // key off posted and skip while the pill showed $1.
    await seedSettings({ balance: 6_000_000, thresholdMicros: 5_000_000 });
    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    const held = await billing.createReservation(micros(5_000_000), {
      idempotencyKey: 'hold-1',
    });
    expect(held.ok).toBe(true);

    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  it('honours a $0 threshold instead of reading it as "unset"', async () => {
    // A falsy-check here silently disabled auto-top-up for anyone who chose
    // "reload when I hit zero", while the settings page still said it was on.
    await seedSettings({ balance: 0, thresholdMicros: 0 });

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await balanceOf()).toBe(100_000_000);
  });

  it('does not credit when the payment intent does not succeed', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_1',
      status: 'requires_action',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await balanceOf()).toBe(3_000_000);
  });

  it('records a card decline and does not throw (#1334)', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });
    paymentIntentCreate.mockRejectedValue(
      cardDeclinedError('insufficient_funds')
    );

    const billing = createBillingMethods(db, teamId, userId);
    await expect(billing.checkAutoTopUp()).resolves.toBeUndefined();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await balanceOf()).toBe(3_000_000);

    const settings = await settingsOf();
    expect(settings?.autoTopUpDeclineCode).toBe('insufficient_funds');
    expect(settings?.autoTopUpFailedAt).toBeInstanceOf(Date);

    expect(loggerError).toHaveBeenCalledWith(
      'Auto top-up declined',
      expect.objectContaining({
        teamId,
        declineCode: 'insufficient_funds',
      })
    );
  });

  it('skips further Stripe charges while the decline cooldown is active', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });
    paymentIntentCreate.mockRejectedValue(cardDeclinedError());

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();
    await billing.checkAutoTopUp();
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(customersRetrieve).toHaveBeenCalledTimes(1);
    expect(loggerDebug).toHaveBeenCalledWith(
      'Auto top-up skipped: decline cooldown',
      expect.objectContaining({ teamId })
    );
  });

  it('retries after the decline cooldown expires', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });
    await db
      .update(teamBillingSettings)
      .set({
        autoTopUpFailedAt: new Date(
          Date.now() - AUTO_TOPUP_DECLINE_COOLDOWN_MS - 1_000
        ),
        autoTopUpDeclineCode: 'insufficient_funds',
      })
      .where(eq(teamBillingSettings.teamId, teamId));

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_retry',
      status: 'succeeded',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect(await balanceOf()).toBe(103_000_000);
    expect((await settingsOf())?.autoTopUpFailedAt).toBeNull();
  });

  it('retries immediately after a successful credit purchase clears the decline', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });
    await db
      .update(teamBillingSettings)
      .set({
        autoTopUpFailedAt: new Date(),
        autoTopUpDeclineCode: 'generic_decline',
      })
      .where(eq(teamBillingSettings.teamId, teamId));

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_after_purchase',
      status: 'succeeded',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.addCredits(micros(1_000_000), {
      description: 'Top-up',
    });

    expect((await settingsOf())?.autoTopUpFailedAt).toBeNull();

    await billing.checkAutoTopUp();
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  it('retries immediately after auto-top-up settings are saved', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });
    await db
      .update(teamBillingSettings)
      .set({
        autoTopUpFailedAt: new Date(),
        autoTopUpDeclineCode: 'card_declined',
      })
      .where(eq(teamBillingSettings.teamId, teamId));

    paymentIntentCreate.mockResolvedValue({
      id: 'pi_after_settings',
      status: 'succeeded',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.updateAutoTopUpSettings({
      enabled: true,
      thresholdMicros: micros(5_000_000),
      amountMicros: micros(100_000_000),
    });

    expect((await settingsOf())?.autoTopUpFailedAt).toBeNull();

    await billing.checkAutoTopUp();
    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
  });

  it('records a non-succeeded PaymentIntent as a decline and skips the next attempt', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });
    paymentIntentCreate.mockResolvedValue({
      id: 'pi_sca',
      status: 'requires_action',
      latest_charge: null,
    });

    const billing = createBillingMethods(db, teamId, userId);
    await billing.checkAutoTopUp();
    await billing.checkAutoTopUp();

    expect(paymentIntentCreate).toHaveBeenCalledTimes(1);
    expect((await settingsOf())?.autoTopUpDeclineCode).toBe('requires_action');
  });

  it('still throws on a non-card Stripe failure so the caller can log it', async () => {
    await seedSettings({ balance: 3_000_000, thresholdMicros: 5_000_000 });
    paymentIntentCreate.mockRejectedValue(new Error('stripe is down'));

    const billing = createBillingMethods(db, teamId, userId);
    await expect(billing.checkAutoTopUp()).rejects.toThrow('stripe is down');
    expect((await settingsOf())?.autoTopUpFailedAt).toBeNull();
  });
});

describe('updateAutoTopUpSettings validation', () => {
  it('rejects an amount that would not lift the balance past the threshold', async () => {
    await db.insert(credits).values({ teamId, balance: 0 });
    const billing = createBillingMethods(db, teamId, userId);

    await expect(
      billing.updateAutoTopUpSettings({
        enabled: true,
        thresholdMicros: micros(20_000_000), // $20
        amountMicros: micros(10_000_000), // $10 — reload stays under it
      })
    ).rejects.toThrow(/greater than the threshold/);
  });
});
