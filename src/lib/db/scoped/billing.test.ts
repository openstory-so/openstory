/**
 * In-memory DB tests for `deductCredits` idempotency (issue #846 RC1).
 *
 * A workflow `step.do` that throws partway (or is killed by an engine abort)
 * re-runs its closure from the top, so `deductCredits` must be safe to replay:
 * with an `idempotencyKey`, the balance UPDATE and the transaction INSERT run
 * in one atomic `db.batch` guarded by the partial unique index on
 * `(team_id, idempotency_key)` — a replay is a no-op that recovers the
 * original transaction id instead of double-debiting the team.
 */

import { micros, negateMicros } from '@/lib/billing/money';
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
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe('deductCredits with an idempotencyKey', () => {
  const rawCost = micros(1_000_000); // $1

  it('debits once and writes a single ledger row', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const result = await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });

    expect(result.chargedAmount).toBe(rawCost);
    expect(result.newBalance).toBe(STARTING_BALANCE - rawCost);
    expect(result.transactionId).not.toBe('');

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(negateMicros(rawCost));
    // The balanceAfter subquery must see the post-UPDATE balance (the batch
    // statements run sequentially inside one transaction).
    expect(rows[0]?.balanceAfter).toBe(STARTING_BALANCE - rawCost);
    expect(rows[0]?.idempotencyKey).toBe('wf-instance-1:image');
  });

  it('replay with the same key is a no-op that returns the original transaction id', async () => {
    const billing = createBillingMethods(db, teamId, userId);

    const first = await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });
    const replay = await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });

    // Must not throw, must not double-debit, must recover the original id.
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.newBalance).toBe(STARTING_BALANCE - rawCost);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(1);

    const [credit] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(credit?.balance).toBe(STARTING_BALANCE - rawCost);
  });

  it('distinct keys are distinct charges', async () => {
    const billing = createBillingMethods(db, teamId, userId);

    await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });
    await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:motion',
    });

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(2);

    // Each ledger row must persist the balance as of ITS charge — a stale
    // read in the balanceAfter subquery would surface on the second row.
    const imageRow = rows.find(
      (r) => r.idempotencyKey === 'wf-instance-1:image'
    );
    const motionRow = rows.find(
      (r) => r.idempotencyKey === 'wf-instance-1:motion'
    );
    expect(imageRow?.balanceAfter).toBe(STARTING_BALANCE - rawCost);
    expect(motionRow?.balanceAfter).toBe(STARTING_BALANCE - 2 * rawCost);

    const [credit] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(credit?.balance).toBe(STARTING_BALANCE - 2 * rawCost);
  });

  it('the same key under a different team charges both teams (key is team-scoped)', async () => {
    const otherTeamId = generateId();
    await db.insert(teams).values({ id: otherTeamId, name: 'T2', slug: 't2' });
    await db
      .insert(credits)
      .values({ teamId: otherTeamId, balance: STARTING_BALANCE });

    const billingA = createBillingMethods(db, teamId, userId);
    const billingB = createBillingMethods(db, otherTeamId, userId);

    const a = await billingA.deductCredits(rawCost, {
      idempotencyKey: 'shared-key',
    });
    const b = await billingB.deductCredits(rawCost, {
      idempotencyKey: 'shared-key',
    });

    expect(a.transactionId).not.toBe(b.transactionId);
    expect(a.newBalance).toBe(STARTING_BALANCE - rawCost);
    expect(b.newBalance).toBe(STARTING_BALANCE - rawCost);
  });
});

describe('deductCredits without an idempotencyKey (keyless path)', () => {
  const rawCost = micros(1_000_000);

  it('charges on every call (HTTP single-shot semantics preserved)', async () => {
    const billing = createBillingMethods(db, teamId, userId);

    const r1 = await billing.deductCredits(rawCost, {
      description: 'one',
    });
    const r2 = await billing.deductCredits(rawCost, {
      description: 'two',
    });

    expect(r1.transactionId).not.toBe(r2.transactionId);
    expect(r2.newBalance).toBe(STARTING_BALANCE - 2 * rawCost);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.idempotencyKey === null)).toBe(true);
  });

  it('returns early without writing anything for a non-positive cost', async () => {
    const billing = createBillingMethods(db, teamId, userId);

    const result = await billing.deductCredits(micros(0));

    expect(result.newBalance).toBe(STARTING_BALANCE);
    expect(result.transactionId).toBe('');

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(0);
  });
});

describe('createReservation / captureReservation / zeroReservation (#1310)', () => {
  const cost = micros(1_000_000); // $1

  it('holds against available without posting usage, and refuses a concurrent overdraw', async () => {
    await db
      .update(credits)
      .set({ balance: 5_000_000 })
      .where(eq(credits.teamId, teamId));

    const billing = createBillingMethods(db, teamId, userId);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        billing.createReservation(cost, {
          idempotencyKey: `batch:${i}:reserve`,
        })
      )
    );

    const reserved = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(reserved).toHaveLength(5);
    expect(refused).toHaveLength(5);

    const available = await billing.getAvailable();
    expect(available.balance).toBe(5_000_000);
    expect(available.reserved).toBe(5_000_000);
    expect(available.available).toBe(0);

    const txRows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(txRows).toHaveLength(0);

    const holds = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.teamId, teamId));
    expect(holds).toHaveLength(5);
  });

  it('replay of the same reservation key is a no-op', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const first = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
    });
    const replay = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (first.ok && replay.ok) {
      expect(replay.reservationId).toBe(first.reservationId);
      expect(replay.replay).toBe(true);
    }

    const holds = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.teamId, teamId));
    expect(holds).toHaveLength(1);
  });

  it('capture equal actual posts usage and leaves leftover 0', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const captured = await billing.captureReservation(
      created.reservationId,
      cost,
      {
        description: 'Motion generation',
        idempotencyKey: 'run-1:motion',
      }
    );

    expect(captured).toEqual({ ok: true, captured: cost });
    expect(await billing.getBalance()).toBe(STARTING_BALANCE - cost);

    const available = await billing.getAvailable();
    expect(available.reserved).toBe(0);
    expect(available.available).toBe(STARTING_BALANCE - cost);
  });

  it('capture under actual leaves leftover held until zeroReservation', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const actual = micros(400_000);
    const captured = await billing.captureReservation(
      created.reservationId,
      actual,
      {
        description: 'LLM',
        idempotencyKey: 'run-1:llm',
      }
    );
    expect(captured).toEqual({ ok: true, captured: actual });

    const afterCapture = await billing.getAvailable();
    expect(afterCapture.balance).toBe(STARTING_BALANCE - actual);
    expect(afterCapture.reserved).toBe(cost - actual);
    expect(afterCapture.available).toBe(STARTING_BALANCE - cost);

    await billing.zeroReservation(created.reservationId);
    const afterZero = await billing.getAvailable();
    expect(afterZero.reserved).toBe(0);
    expect(afterZero.available).toBe(STARTING_BALANCE - actual);
  });

  it('capture over actual grows the hold when available covers the extra', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const actual = micros(1_250_000);
    const captured = await billing.captureReservation(
      created.reservationId,
      actual,
      {
        description: 'Motion generation',
        idempotencyKey: 'run-1:motion',
      }
    );

    expect(captured).toEqual({ ok: true, captured: actual });
    expect(await billing.getBalance()).toBe(STARTING_BALANCE - actual);

    const replay = await billing.captureReservation(
      created.reservationId,
      actual,
      {
        description: 'Motion generation',
        idempotencyKey: 'run-1:motion',
      }
    );
    expect(replay).toEqual({ ok: true, captured: actual });
    const afterReplay = await billing.getAvailable();
    expect(afterReplay.reserved).toBe(0);
    expect(afterReplay.balance).toBe(STARTING_BALANCE - actual);

    const [hold] = await db
      .select({
        remaining: creditReservations.remainingAmount,
        original: creditReservations.originalAmount,
      })
      .from(creditReservations)
      .where(eq(creditReservations.id, created.reservationId));
    expect(hold).toEqual({ remaining: 0, original: actual });

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(1);
  });

  it('capture extra that cannot be paid charges remaining and reports the skipped delta', async () => {
    await db
      .update(credits)
      .set({ balance: 1_000_000 })
      .where(eq(credits.teamId, teamId));

    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const actual = micros(1_250_000);
    const captured = await billing.captureReservation(
      created.reservationId,
      actual,
      {
        description: 'Motion generation',
        idempotencyKey: 'run-1:motion',
      }
    );

    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.captured).toBe(cost);
    expect(captured.skippedDeltaMicros).toBe(micros(250_000));
    expect(await billing.getBalance()).toBe(0);
  });

  it('capture against emptied remaining reports skipped delta instead of silent zero', async () => {
    await db
      .update(credits)
      .set({ balance: 1_000_000 })
      .where(eq(credits.teamId, teamId));

    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await billing.captureReservation(created.reservationId, cost, {
      description: 'first',
      idempotencyKey: 'run-1:a',
    });
    const second = await billing.captureReservation(
      created.reservationId,
      micros(500_000),
      {
        description: 'second',
        idempotencyKey: 'run-1:b',
      }
    );
    expect(second).toEqual({
      ok: true,
      captured: 0,
      skippedDeltaMicros: micros(500_000),
    });
  });

  it('concurrent captures split remaining instead of silent-zeroing a sibling', async () => {
    // Posted equals the hold so grow cannot cover the extra — this is the
    // #1310 race: two $1.20 captures against $1.80 remaining used to let the
    // loser return captured:0 with no skippedDelta, so deduction posted $0.
    const held = micros(1_800_000);
    await db
      .update(credits)
      .set({ balance: held })
      .where(eq(credits.teamId, teamId));

    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(held, {
      idempotencyKey: 'run-1:reserve',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const actual = micros(1_200_000);
    const results = await Promise.all([
      billing.captureReservation(created.reservationId, actual, {
        description: 'Motion A',
        idempotencyKey: 'run-1:motion-a',
      }),
      billing.captureReservation(created.reservationId, actual, {
        description: 'Motion B',
        idempotencyKey: 'run-1:motion-b',
      }),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const okResults = results.filter(
      (r): r is Extract<typeof r, { ok: true }> => r.ok
    );
    const capturedSum = okResults.reduce((sum, r) => sum + r.captured, 0);
    const skippedSum = okResults.reduce(
      (sum, r) => sum + (r.skippedDeltaMicros ?? 0),
      0
    );
    expect(capturedSum).toBe(held);
    expect(skippedSum).toBe(micros(600_000));
    expect(
      okResults.some((r) => r.captured === 0 && !r.skippedDeltaMicros)
    ).toBe(false);
    expect(await billing.getBalance()).toBe(0);
  });

  it('expired remaining does not reduce available', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
      ttlMs: 1,
    });
    expect(created.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const available = await billing.getAvailable();
    expect(available.reserved).toBe(0);
    expect(available.available).toBe(STARTING_BALANCE);
  });

  it('capture after expiry of this row still posts usage', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const created = await billing.createReservation(cost, {
      idempotencyKey: 'run-1:reserve',
      ttlMs: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const captured = await billing.captureReservation(
      created.reservationId,
      cost,
      {
        description: 'Motion generation',
        idempotencyKey: 'run-1:motion',
      }
    );
    expect(captured).toEqual({ ok: true, captured: cost });
    expect(await billing.getBalance()).toBe(STARTING_BALANCE - cost);
  });

  it('tryDeductCredits refuses an overdraft instead of throwing', async () => {
    await db
      .update(credits)
      .set({ balance: 500_000 })
      .where(eq(credits.teamId, teamId));

    const billing = createBillingMethods(db, teamId, userId);
    const result = await billing.tryDeductCredits(cost, {
      description: 'Motion generation',
      idempotencyKey: 'wf-1:motion',
    });

    expect(result.ok).toBe(false);

    const [credit] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(credit?.balance).toBe(500_000);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(0);
  });
});
