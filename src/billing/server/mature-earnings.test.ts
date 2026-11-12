/**
 * The earnings sweep on the real migrations: an earning matures only after
 * its hold, into exactly one `credit_earned` row and one `earned` batch,
 * under a repeated and a concurrent sweep; a cancelled one never does. And
 * the cron is wired in all three places without falling through.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  creditBatches,
  credits,
  gatewayApps,
  gatewayEarnings,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { EARNING_HOLD_DAYS } from '@/billing/charge-lines';
import { createEarningsMethods, earningCreditKey } from './db/earnings';
import { MATURE_EARNINGS_CRON, matureEarnings } from './mature-earnings';
import { FAL_PRICING_CRON } from './refresh-fal-pricing';
import { FAL_BILLING_RECONCILE_CRON } from './reconcile-fal-billing';
import { BYTEPLUS_ASSETS_RECONCILE_CRON } from '@/models/server/reconcile-byteplus-assets';

const DAY_MS = 86_400_000;

describe('earnings cron wiring', () => {
  const wrangler = readFileSync('wrangler.jsonc', 'utf-8');
  const server = readFileSync('src/server.ts', 'utf-8');

  it('is registered in the default block and in [env.production]', () => {
    expect(wrangler.slice(0, wrangler.indexOf('"env"'))).toContain(
      MATURE_EARNINGS_CRON
    );
    expect(wrangler.slice(wrangler.indexOf('"production"'))).toContain(
      MATURE_EARNINGS_CRON
    );
  });

  it('has its own expression, so it cannot fall through to another job', () => {
    expect(
      new Set([
        MATURE_EARNINGS_CRON,
        FAL_PRICING_CRON,
        FAL_BILLING_RECONCILE_CRON,
        BYTEPLUS_ASSETS_RECONCILE_CRON,
        '*/5 * * * *',
      ]).size
    ).toBe(5);
  });

  it('is matched in scheduled() and returns before the reconcile sweep', () => {
    const branch = server.indexOf('controller.cron === MATURE_EARNINGS_CRON');
    expect(branch).toBeGreaterThan(-1);
    expect(server.indexOf('matureEarnings()', branch)).toBeGreaterThan(branch);
    expect(server.indexOf('return;', branch)).toBeLessThan(
      server.indexOf('reconcileAllStuckJobs()', branch)
    );
  });
});

describe('matureEarnings', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  const payerId = generateId();
  const payeeId = generateId();
  const userId = generateId();
  let appId = '';
  const now = new Date('2026-12-01T12:00:00Z');

  beforeAll(async () => {
    ({ db, close: closeDb } = await createTestDb());
    await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
    await db.insert(organization).values([
      { id: payerId, name: 'Payer', slug: 'payer' },
      { id: payeeId, name: 'Maker', slug: 'maker' },
    ]);
    const [app] = await db
      .insert(gatewayApps)
      .values({
        organizationId: payeeId,
        oauthClientId: 'client',
        name: 'App',
        createdByUserId: userId,
      })
      .returning();
    appId = app?.id ?? '';
  });

  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await db.delete(gatewayEarnings);
    await db.delete(chargeLines);
    await db.delete(creditBatches);
    await db.delete(transactions);
    await db.delete(credits);
    await db.insert(credits).values({ organizationId: payeeId, balance: 0 });
  });

  /** A settled payee line and its earning, charged `ageDays` before `now`. */
  async function earning(amountMicros: number, ageDays: number) {
    const chargedAt = new Date(now.getTime() - ageDays * DAY_MS);
    const transactionId = generateId();
    await db.insert(transactions).values({
      id: transactionId,
      organizationId: payerId,
      type: 'credit_usage',
      amount: -amountMicros,
      balanceAfter: 0,
    });
    const [line] = await db
      .insert(chargeLines)
      .values({
        organizationId: payerId,
        transactionId,
        kind: 'app_margin',
        amountMicros,
        payeeOrganizationId: payeeId,
        appId,
      })
      .returning();
    const [row] = await db
      .insert(gatewayEarnings)
      .values({
        chargeLineId: line?.id ?? '',
        payerOrganizationId: payerId,
        payeeOrganizationId: payeeId,
        appId,
        amountMicros,
        availableAt: new Date(chargedAt.getTime() + EARNING_HOLD_DAYS * DAY_MS),
        createdAt: chargedAt,
      })
      .returning();
    if (!row) throw new Error('expected an earning');
    return row.id;
  }

  const balance = async () =>
    (
      await db
        .select({ balance: credits.balance })
        .from(credits)
        .where(eq(credits.organizationId, payeeId))
    )[0]?.balance;

  const earned = () =>
    db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.organizationId, payeeId),
          eq(transactions.type, 'credit_earned')
        )
      );

  const rowOf = async (id: string) =>
    (
      await db.select().from(gatewayEarnings).where(eq(gatewayEarnings.id, id))
    )[0];

  it('matures only earnings past their hold, into a credit_earned row and an earned batch', async () => {
    const due = await earning(2_000, EARNING_HOLD_DAYS + 1);
    const held = await earning(3_000, EARNING_HOLD_DAYS - 1);
    const summary = await matureEarnings({ db, now });
    expect(summary).toMatchObject({ matured: 1, credited: 2_000, retried: 0 });
    expect(await balance()).toBe(2_000);
    const [credit] = await earned();
    expect(credit).toMatchObject({
      amount: 2_000,
      userId: null,
      idempotencyKey: earningCreditKey(due),
    });
    expect(await rowOf(due)).toMatchObject({
      status: 'matured',
      maturedAt: now,
      transactionId: credit?.id,
    });
    expect(await rowOf(held)).toMatchObject({
      status: 'pending',
      transactionId: null,
    });
    expect(await db.select().from(creditBatches)).toEqual([
      expect.objectContaining({
        organizationId: payeeId,
        source: 'earned',
        originalAmount: 2_000,
        transactionId: credit?.id,
      }),
    ]);
  });

  it('credits exactly once under a repeated sweep', async () => {
    await earning(2_000, EARNING_HOLD_DAYS);
    await matureEarnings({ db, now });
    expect(await matureEarnings({ db, now })).toMatchObject({ matured: 0 });
    const later = new Date(now.getTime() + DAY_MS);
    await matureEarnings({ db, now: later });
    expect(await earned()).toHaveLength(1);
    expect(await balance()).toBe(2_000);
  });

  it('credits exactly once under concurrent sweeps', async () => {
    const ids = await Promise.all([
      earning(1_000, 20),
      earning(2_000, 20),
      earning(4_000, 20),
    ]);
    const runs = await Promise.all([
      matureEarnings({ db, now }),
      matureEarnings({ db, now }),
      matureEarnings({ db, now }),
    ]);
    expect(runs.reduce((sum, run) => sum + run.matured, 0)).toBe(3);
    expect(await earned()).toHaveLength(3);
    expect(await balance()).toBe(7_000);
    expect(await db.select().from(creditBatches)).toHaveLength(3);
    for (const id of ids) {
      expect((await rowOf(id))?.transactionId).not.toBeNull();
    }
  });

  it('retries a claim whose credit was lost, without crediting twice', async () => {
    const lost = await earning(2_000, 30);
    const linked = await earning(3_000, 30);
    const claimedAt = new Date(now.getTime() - DAY_MS);
    await db
      .update(gatewayEarnings)
      .set({ status: 'matured', maturedAt: claimedAt })
      .where(eq(gatewayEarnings.id, lost));
    // The credit landed but the link did not.
    await db
      .update(gatewayEarnings)
      .set({ status: 'matured', maturedAt: claimedAt })
      .where(eq(gatewayEarnings.id, linked));
    const [prior] = await db
      .insert(transactions)
      .values({
        organizationId: payeeId,
        type: 'credit_earned',
        amount: 3_000,
        balanceAfter: 3_000,
        idempotencyKey: earningCreditKey(linked),
      })
      .returning();
    await db
      .update(credits)
      .set({ balance: 3_000 })
      .where(eq(credits.organizationId, payeeId));

    expect(await matureEarnings({ db, now })).toMatchObject({
      matured: 0,
      retried: 2,
      credited: 2_000,
    });
    expect(await balance()).toBe(5_000);
    expect(await earned()).toHaveLength(2);
    expect((await rowOf(linked))?.transactionId).toBe(prior?.id);
    expect((await rowOf(lost))?.transactionId).not.toBeNull();
  });

  it('a cancelled earning never matures, and a matured one cannot be cancelled', async () => {
    const cancelled = await earning(2_000, 1);
    const matured = await earning(3_000, 20);
    const payer = createEarningsMethods(db, payerId);
    expect(
      await createEarningsMethods(db, payeeId).cancelPending(cancelled)
    ).toBe(false);
    expect(await payer.cancelPending(cancelled)).toBe(true);
    await matureEarnings({ db, now: new Date(now.getTime() + 30 * DAY_MS) });
    expect(await rowOf(cancelled)).toMatchObject({
      status: 'cancelled',
      transactionId: null,
    });
    expect(await payer.cancelPending(matured)).toBe(false);
    expect((await rowOf(matured))?.status).toBe('matured');
    expect(await balance()).toBe(3_000);
  });

  it("reads an app's pending and matured totals for its organization", async () => {
    await earning(2_000, 20);
    await earning(3_000, 1);
    await matureEarnings({ db, now });
    const [summary] = await createEarningsMethods(db, payeeId).byApp([appId]);
    expect(summary).toMatchObject({
      appId,
      pendingMicros: 3_000,
      maturedMicros: 2_000,
    });
    expect(summary?.recent.map((row) => row.status)).toEqual([
      'pending',
      'matured',
    ]);
    expect(await createEarningsMethods(db, payerId).byApp([appId])).toEqual([
      { appId, pendingMicros: 0, maturedMicros: 0, recent: [] },
    ]);
  });
});
