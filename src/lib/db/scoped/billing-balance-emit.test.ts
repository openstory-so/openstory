/**
 * #1090 — `deductCredits` / `addCredits` emit `billing.balance:updated` only for
 * new ledger rows (not idempotent workflow replays).
 */

import { micros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  creditReservations,
  credits,
  teams,
  transactions,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const emitMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/realtime', () => ({
  getBillingChannel: () => ({
    emit: emitMock,
    history: async () => [],
  }),
  billingChannelId: (teamId: string) => `billing:${teamId}`,
}));

// Dynamic import so the mock applies (vi.mock is hoisted; static import of
// createBillingMethods would bind before the mock in some bundlers — follow
// the project doMock pattern via mocked module + static import is fine with
// vi.mock hoisting in Vitest).
import { createBillingMethods } from './billing';

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

const STARTING_BALANCE = 100_000_000; // $100

async function seed() {
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(credits);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
  await db.insert(credits).values({ teamId, balance: STARTING_BALANCE });
  emitMock.mockClear();
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('billing.balance:updated emit (#1090)', () => {
  const rawCost = micros(1_000_000); // $1

  it('emits once on a new deductCredits charge', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const result = await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-1:image',
    });

    // void emit — microtask; flush
    await Promise.resolve();

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('billing.balance:updated', {
      teamId,
      balanceUsd: 99,
      availableUsd: 99,
      reservedUsd: 0,
      amountUsd: -1,
      transactionId: result.transactionId,
      type: 'credit_usage',
    });
  });

  it('does not re-emit on idempotent deductCredits replay', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-1:image',
    });
    await Promise.resolve();
    emitMock.mockClear();

    await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-1:image',
    });
    await Promise.resolve();

    expect(emitMock).not.toHaveBeenCalled();
  });

  it('emits on addCredits', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const result = await billing.addCredits(micros(5_000_000), {
      description: 'test top-up',
    });
    await Promise.resolve();

    expect(result).not.toBeNull();
    if (!result) return;
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('billing.balance:updated', {
      teamId,
      balanceUsd: 105,
      availableUsd: 105,
      reservedUsd: 0,
      amountUsd: 5,
      transactionId: result.transactionId,
      type: 'credit_purchase',
    });
  });

  it('emits available/reserved on createReservation, not on replay', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(micros(10_000_000), {
      idempotencyKey: 'run-1:reserve',
    });
    await Promise.resolve();

    expect(created.ok).toBe(true);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('billing.balance:updated', {
      teamId,
      balanceUsd: 100,
      availableUsd: 90,
      reservedUsd: 10,
      amountUsd: 0,
    });

    emitMock.mockClear();
    await billing.createReservation(micros(10_000_000), {
      idempotencyKey: 'run-1:reserve',
    });
    await Promise.resolve();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('emits restored available after zeroReservation', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(micros(10_000_000), {
      idempotencyKey: 'run-1:reserve',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await Promise.resolve();
    emitMock.mockClear();

    await billing.zeroReservation(created.reservationId);
    await Promise.resolve();

    expect(emitMock).toHaveBeenCalledWith('billing.balance:updated', {
      teamId,
      balanceUsd: 100,
      availableUsd: 100,
      reservedUsd: 0,
      amountUsd: 0,
    });
  });
});
