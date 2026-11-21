/**
 * The user-pays cap inside `createReservation`'s own statement
 * (docs/architecture/model-gateway.md § The cap): what counts against it,
 * what does not, and that a hold without `spendCap` behaves as before.
 */

import { micros } from '@/billing/money';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  chargeLines,
  creditReservations,
  credits,
  gatewayGrants,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBillingMethods } from './billing';
import { utcMonthStart } from './spend-cap';

let closeDb: () => Promise<void>;
let db: Database;
let organizationId = '';
let otherOrganizationId = '';
let userId = '';

const CLIENT = 'client-a';
const CAP = 10_000_000; // $10
const cap = { oauthClientId: CLIENT, appId: null };

async function seed() {
  await db.delete(chargeLines);
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(gatewayGrants);
  await db.delete(credits);
  await db.delete(organization);
  await db.delete(user);
  organizationId = generateId();
  otherOrganizationId = generateId();
  userId = generateId();
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: 't' },
    { id: otherOrganizationId, name: 'O', slug: 'o' },
  ]);
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(credits).values([
    { organizationId, balance: 1_000_000_000 },
    { organizationId: otherOrganizationId, balance: 1_000_000_000 },
  ]);
  await db.insert(gatewayGrants).values({
    oauthClientId: CLIENT,
    userId,
    organizationId,
    monthlyCapMicros: CAP,
  });
}

/** A settled line for (payer, client) at `at`, with its debit. */
async function settledLine(input: {
  amount: number;
  at: Date;
  payer?: string;
  client?: string | null;
}) {
  const payer = input.payer ?? organizationId;
  const transactionId = generateId();
  await db.insert(transactions).values({
    id: transactionId,
    organizationId: payer,
    type: 'credit_usage',
    amount: -input.amount,
    balanceAfter: 0,
    createdAt: input.at,
  });
  await db.insert(chargeLines).values({
    organizationId: payer,
    transactionId,
    kind: 'provider_cost',
    amountMicros: input.amount,
    oauthClientId: input.client === undefined ? CLIENT : input.client,
    createdAt: input.at,
  });
}

/** A hold for the client, as another job's submit would leave it. */
async function hold(input: {
  remaining: number;
  expiresAt?: Date;
  client?: string | null;
}) {
  await db.insert(creditReservations).values({
    organizationId,
    userId,
    originalAmount: input.remaining,
    remainingAmount: input.remaining,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 3_600_000),
    idempotencyKey: generateId(),
    oauthClientId: input.client === undefined ? CLIENT : input.client,
  });
}

function billing() {
  return createBillingMethods(db, organizationId, userId);
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await seed();
});

describe('createReservation with a spend cap', () => {
  it('holds under the cap and exactly at it, and refuses one microdollar over', async () => {
    const under = await billing().createReservation(micros(CAP - 1), {
      idempotencyKey: 'under',
      spendCap: cap,
    });
    expect(under.ok).toBe(true);
    await db.delete(creditReservations);

    const at = await billing().createReservation(micros(CAP), {
      idempotencyKey: 'at',
      spendCap: cap,
    });
    expect(at.ok).toBe(true);
    await db.delete(creditReservations);

    const over = await billing().createReservation(micros(CAP + 1), {
      idempotencyKey: 'over',
      spendCap: cap,
    });
    expect(over.ok).toBe(false);
    expect(await db.select().from(creditReservations)).toEqual([]);
  });

  it('stamps the client and app on the hold', async () => {
    const created = await billing().createReservation(micros(1_000), {
      idempotencyKey: 'stamped',
      spendCap: { oauthClientId: CLIENT, appId: 'app-1' },
    });
    if (!created.ok) throw new Error('expected a hold');
    const [row] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, created.reservationId));
    expect(row).toMatchObject({ oauthClientId: CLIENT, appId: 'app-1' });
  });

  it("counts this UTC month's settled lines for this payer and client only", async () => {
    const now = new Date();
    const lastMonth = new Date(utcMonthStart(now).getTime() - 1000);
    await settledLine({ amount: 6_000_000, at: now });
    // None of these count.
    await settledLine({ amount: 9_000_000, at: lastMonth });
    await settledLine({ amount: 9_000_000, at: now, client: 'client-b' });
    await settledLine({ amount: 9_000_000, at: now, client: null });
    await settledLine({
      amount: 9_000_000,
      at: now,
      payer: otherOrganizationId,
    });

    const fits = await billing().createReservation(micros(4_000_000), {
      idempotencyKey: 'fits',
      spendCap: cap,
    });
    expect(fits.ok).toBe(true);
    const past = await billing().createReservation(micros(1), {
      idempotencyKey: 'past',
      spendCap: cap,
    });
    expect(past.ok).toBe(false);
  });

  it('counts live holds for the client and ignores expired, zeroed and other holds', async () => {
    await hold({ remaining: 5_000_000 });
    await hold({ remaining: 9_000_000, expiresAt: new Date(Date.now() - 1) });
    await hold({ remaining: 0 });
    await hold({ remaining: 9_000_000, client: 'client-b' });
    await hold({ remaining: 9_000_000, client: null });

    expect(
      (
        await billing().createReservation(micros(5_000_001), {
          idempotencyKey: 'too-much',
          spendCap: cap,
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await billing().createReservation(micros(5_000_000), {
          idempotencyKey: 'rest',
          spendCap: cap,
        })
      ).ok
    ).toBe(true);
  });

  it('lets two holds that together pass the cap not both land', async () => {
    const results = await Promise.all([
      billing().createReservation(micros(6_000_000), {
        idempotencyKey: 'one',
        spendCap: cap,
      }),
      billing().createReservation(micros(6_000_000), {
        idempotencyKey: 'two',
        spendCap: cap,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await db.select().from(creditReservations)).toHaveLength(1);
  });

  it('refuses without a live grant: missing, revoked, or another user or organization', async () => {
    await db.update(gatewayGrants).set({ revokedAt: new Date() });
    const revoked = await billing().createReservation(micros(1), {
      idempotencyKey: 'revoked',
      spendCap: cap,
    });
    expect(revoked.ok).toBe(false);

    const otherUser = generateId();
    await db
      .insert(user)
      .values({ id: otherUser, name: 'V', email: 'v@e.com' });
    await db.insert(gatewayGrants).values([
      {
        oauthClientId: CLIENT,
        userId: otherUser,
        organizationId,
        monthlyCapMicros: CAP,
      },
      {
        oauthClientId: CLIENT,
        userId,
        organizationId: otherOrganizationId,
        monthlyCapMicros: CAP,
      },
    ]);
    const notMine = await billing().createReservation(micros(1), {
      idempotencyKey: 'not-mine',
      spendCap: cap,
    });
    expect(notMine.ok).toBe(false);
    const missing = await billing().createReservation(micros(1), {
      idempotencyKey: 'missing',
      spendCap: { oauthClientId: 'never-granted', appId: null },
    });
    expect(missing.ok).toBe(false);
  });

  it('still refuses for the balance under a roomy cap', async () => {
    await db
      .update(credits)
      .set({ balance: 1_000 })
      .where(eq(credits.organizationId, organizationId));
    const result = await billing().createReservation(micros(2_000), {
      idempotencyKey: 'broke',
      spendCap: cap,
    });
    expect(result.ok).toBe(false);
  });
});

describe('createReservation without a spend cap', () => {
  it('is untouched by grants: no grant needed, no cap applied, no client stamped', async () => {
    await db.delete(gatewayGrants);
    await settledLine({ amount: 50_000_000, at: new Date() });
    const created = await billing().createReservation(micros(CAP * 5), {
      idempotencyKey: 'app-pays',
    });
    if (!created.ok) throw new Error('expected a hold');
    const [row] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, created.reservationId));
    expect(row).toMatchObject({ oauthClientId: null, appId: null });
  });
});

describe('a settle above its hold', () => {
  it('is not blocked by the cap, and counts against it afterwards', async () => {
    const created = await billing().createReservation(micros(CAP), {
      idempotencyKey: 'whole-cap',
      spendCap: cap,
    });
    if (!created.ok) throw new Error('expected a hold');
    const settled = await billing().settleReservation(
      created.reservationId,
      [{ kind: 'provider_cost', amountMicros: micros(CAP + 3_000_000) }],
      {
        idempotencyKey: 'whole-cap:settle',
        attribution: { oauthClientId: CLIENT },
      }
    );
    if (!settled.ok) throw new Error('expected a settle');
    expect(settled.captured).toBe(CAP + 3_000_000);
    expect(settled.lines.reduce((sum, l) => sum + l.amountMicros, 0)).toBe(
      settled.captured
    );

    const next = await billing().createReservation(micros(1), {
      idempotencyKey: 'after',
      spendCap: cap,
    });
    expect(next.ok).toBe(false);
  });
});
