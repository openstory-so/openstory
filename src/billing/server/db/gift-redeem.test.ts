import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  creditBatches,
  creditReservations,
  credits,
  giftTokenRedemptions,
  giftTokens,
  teams,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { relations } from '@/platform/server/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBillingMethods } from './billing';

let client: Client;
let db: Database;
let teamId = '';
let otherTeamId = '';
let userId = '';
let otherUserId = '';

const TEN_DOLLARS = 10_000_000;

async function seed() {
  await db.delete(giftTokenRedemptions);
  await db.delete(giftTokens);
  await db.delete(creditBatches);
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(credits);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  otherTeamId = generateId();
  userId = generateId();
  otherUserId = generateId();
  await db.insert(teams).values([
    { id: teamId, name: 'T', slug: `t-${teamId}` },
    { id: otherTeamId, name: 'O', slug: `o-${otherTeamId}` },
  ]);
  await db.insert(user).values([
    { id: userId, name: 'U', email: `${userId}@example.com` },
    { id: otherUserId, name: 'O', email: `${otherUserId}@example.com` },
  ]);
  await db.insert(credits).values([
    { teamId, balance: 0 },
    { teamId: otherTeamId, balance: 0 },
  ]);
}

async function insertCode(opts: {
  code: string;
  maxRedemptions?: number;
  expiresAt?: Date | null;
}) {
  const id = generateId();
  await db.insert(giftTokens).values({
    id,
    code: opts.code,
    amountMicros: TEN_DOLLARS,
    maxRedemptions: opts.maxRedemptions ?? 1,
    createdByUserId: userId,
    expiresAt: opts.expiresAt ?? null,
  });
  return id;
}

function redeem(
  code: string,
  who: { teamId: string; userId: string } = { teamId, userId }
) {
  const billing = createBillingMethods(db, who.teamId, who.userId);
  return billing.redeemGiftToken({
    code,
    teamId: who.teamId,
    userId: who.userId,
    addCredits: billing.addCredits,
  });
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

describe('redeemGiftToken', () => {
  it('adds the code amount once', async () => {
    await insertCode({ code: 'ABCDEF' });

    const result = await redeem(' abcdef ');

    expect(result).toEqual({
      status: 'redeemed',
      newBalance: 10,
      amountUsd: 10,
    });
    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(row?.balance).toBe(TEN_DOLLARS);
  });

  it('refuses an unknown code and an expired code', async () => {
    expect(await redeem('MISSING')).toEqual({
      status: 'refused',
      reason: 'invalid',
    });

    await insertCode({
      code: 'OLDCOD',
      expiresAt: new Date('2020-01-01T00:00:00Z'),
    });
    expect(await redeem('OLDCOD')).toEqual({
      status: 'refused',
      reason: 'expired',
    });
  });

  it('tells the same person they already redeemed, ahead of fully redeemed', async () => {
    await insertCode({ code: 'USED01' });
    expect((await redeem('USED01')).status).toBe('redeemed');

    expect(await redeem('USED01')).toEqual({
      status: 'refused',
      reason: 'already_redeemed',
    });
    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(row?.balance).toBe(TEN_DOLLARS);
  });

  it('tells a teammate the code is once per account', async () => {
    await insertCode({ code: 'TEAM01' });
    expect((await redeem('TEAM01')).status).toBe('redeemed');

    expect(await redeem('TEAM01', { teamId, userId: otherUserId })).toEqual({
      status: 'refused',
      reason: 'one_per_account',
    });
  });

  it('says fully redeemed when another account used the last slot', async () => {
    await insertCode({ code: 'FULL01' });
    expect(
      (await redeem('FULL01', { teamId: otherTeamId, userId: otherUserId }))
        .status
    ).toBe('redeemed');

    expect(await redeem('FULL01')).toEqual({
      status: 'refused',
      reason: 'fully_redeemed',
    });
    const [row] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(row?.balance).toBe(0);
  });

  it('treats a redemption with no user as the account limit', async () => {
    const tokenId = await insertCode({ code: 'NULL01' });
    await db.insert(giftTokenRedemptions).values({
      id: generateId(),
      giftTokenId: tokenId,
      teamId,
      userId: null,
    });

    expect(await redeem('NULL01')).toEqual({
      status: 'refused',
      reason: 'one_per_account',
    });
  });
});
