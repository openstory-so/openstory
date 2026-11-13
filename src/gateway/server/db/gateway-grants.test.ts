/**
 * Grants on the real migrations: write, update (re-consent), revoke, the
 * membership guard, and the standing reads Settings and the API show.
 */

import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  chargeLines,
  creditReservations,
  gatewayAppSkus,
  gatewayApps,
  gatewayGrants,
  member,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { ValidationError } from '@/platform/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGatewayGrantsMethods } from './gateway-grants';

let db: Database;
let closeDb: () => Promise<void>;
const userId = generateId();
const organizationId = generateId();
const strangerOrganizationId = generateId();

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: 't' },
    { id: strangerOrganizationId, name: 'S', slug: 's' },
  ]);
  await db.insert(member).values({
    id: generateId(),
    organizationId,
    userId,
    role: 'member',
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await closeDb();
});

describe('gatewayGrants', () => {
  const grants = () => createGatewayGrantsMethods(db, userId);

  it('writes, updates on re-consent, revokes and revives a grant', async () => {
    expect(
      await grants().setCap({
        oauthClientId: 'c1',
        organizationId,
        monthlyCapMicros: 20_000_000,
      })
    ).toBe(true);
    expect(await grants().getStanding('c1', organizationId)).toMatchObject({
      monthlyCapMicros: 20_000_000,
      spentMicros: 0,
      heldMicros: 0,
      remainingMicros: 20_000_000,
    });

    await grants().setCap({
      oauthClientId: 'c1',
      organizationId,
      monthlyCapMicros: 50_000_000,
    });
    const rows = await db.select().from(gatewayGrants);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.monthlyCapMicros).toBe(50_000_000);

    await grants().revoke({ oauthClientId: 'c1', organizationId });
    expect(await grants().getStanding('c1', organizationId)).toBeNull();
    expect(await grants().listStandings()).toEqual([]);

    await grants().setCap({
      oauthClientId: 'c1',
      organizationId,
      monthlyCapMicros: 5_000_000,
    });
    expect(await grants().getStanding('c1', organizationId)).toMatchObject({
      monthlyCapMicros: 5_000_000,
    });
  });

  it('revokes every organization of a client when none is named', async () => {
    await grants().setCap({
      oauthClientId: 'c2',
      organizationId,
      monthlyCapMicros: 5_000_000,
    });
    await grants().revoke({ oauthClientId: 'c2', organizationId: null });
    expect(await grants().getStanding('c2', organizationId)).toBeNull();
  });

  it('writes nothing for an organization the user is not a member of', async () => {
    expect(
      await grants().setCap({
        oauthClientId: 'c1',
        organizationId: strangerOrganizationId,
        monthlyCapMicros: 5_000_000,
      })
    ).toBe(false);
    expect(await grants().getStanding('c1', strangerOrganizationId)).toBeNull();
  });

  it('refuses a cap outside the bounds or in cents', async () => {
    for (const monthlyCapMicros of [0, 500_000, 1_500_000, 2_000_000_000]) {
      await expect(
        grants().setCap({
          oauthClientId: 'c1',
          organizationId,
          monthlyCapMicros,
        })
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('reports spend, holds and what remains, never below zero', async () => {
    await grants().setCap({
      oauthClientId: 'c3',
      organizationId,
      monthlyCapMicros: 10_000_000,
    });
    const transactionId = generateId();
    await db.insert(transactions).values({
      id: transactionId,
      organizationId,
      type: 'credit_usage',
      amount: -7_000_000,
      balanceAfter: 0,
    });
    await db.insert(chargeLines).values({
      organizationId,
      transactionId,
      kind: 'provider_cost',
      amountMicros: 7_000_000,
      oauthClientId: 'c3',
    });
    await db.insert(creditReservations).values({
      organizationId,
      userId,
      originalAmount: 6_000_000,
      remainingAmount: 6_000_000,
      expiresAt: new Date(Date.now() + 3_600_000),
      idempotencyKey: generateId(),
      oauthClientId: 'c3',
    });
    const expected = {
      oauthClientId: 'c3',
      organizationId,
      monthlyCapMicros: 10_000_000,
      spentMicros: 7_000_000,
      heldMicros: 6_000_000,
      remainingMicros: 0,
      accepted: { marginBps: 0, skuPrices: {} },
    };
    expect(await grants().getStanding('c3', organizationId)).toEqual(expected);
    expect(await grants().listStandings()).toContainEqual(expected);
  });

  it("lists only the user's grants in organizations they still belong to", async () => {
    await db.insert(gatewayGrants).values({
      oauthClientId: 'c4',
      userId,
      organizationId: strangerOrganizationId,
      monthlyCapMicros: 5_000_000,
    });
    const other = createGatewayGrantsMethods(db, generateId());
    expect(await other.listStandings()).toEqual([]);
    expect(
      (await grants().listStandings()).map((grant) => grant.oauthClientId)
    ).not.toContain('c4');
  });
});

describe('accepted terms', () => {
  const grants = () => createGatewayGrantsMethods(db, userId);
  const shown = { marginBps: 2500, skuPrices: { hd: 900_000, ghost: 1 } };

  beforeAll(async () => {
    const [app] = await db
      .insert(gatewayApps)
      .values({
        organizationId: strangerOrganizationId,
        oauthClientId: 'paid',
        name: 'Paid',
        createdByUserId: userId,
        marginBps: 2000,
      })
      .returning();
    if (!app) throw new Error('expected an app');
    await db.insert(gatewayAppSkus).values([
      { appId: app.id, key: 'hd', name: 'HD', priceMicros: 500_000 },
      {
        appId: app.id,
        key: 'old',
        name: 'Old',
        priceMicros: 1,
        status: 'archived',
      },
    ]);
  });

  it('a new grant without shown terms accepts nothing', async () => {
    await grants().setCap({
      oauthClientId: 'paid',
      organizationId,
      monthlyCapMicros: 10_000_000,
    });
    expect(
      (await grants().getStanding('paid', organizationId))?.accepted
    ).toEqual({ marginBps: 0, skuPrices: {} });
  });

  it('consent records what was shown, bounded by what the app asks now', async () => {
    await grants().setCap({
      oauthClientId: 'paid',
      organizationId,
      monthlyCapMicros: 10_000_000,
      shownTerms: shown,
    });
    expect(
      (await grants().getStanding('paid', organizationId))?.accepted
    ).toEqual({ marginBps: 2000, skuPrices: { hd: 500_000 } });
  });

  it('changing the cap alone keeps the accepted terms', async () => {
    await grants().setCap({
      oauthClientId: 'paid',
      organizationId,
      monthlyCapMicros: 30_000_000,
    });
    expect(
      (await grants().getStanding('paid', organizationId))?.accepted
    ).toEqual({ marginBps: 2000, skuPrices: { hd: 500_000 } });
  });

  it('acceptTerms needs a live grant and records no more than the app asks', async () => {
    expect(
      await grants().acceptTerms({
        oauthClientId: 'paid',
        organizationId,
        shownTerms: { marginBps: 100, skuPrices: {} },
      })
    ).toBe(true);
    expect(
      (await grants().getStanding('paid', organizationId))?.accepted
    ).toEqual({ marginBps: 100, skuPrices: {} });
    expect(
      await grants().acceptTerms({
        oauthClientId: 'paid',
        organizationId: strangerOrganizationId,
        shownTerms: shown,
      })
    ).toBe(false);
    await grants().revoke({ oauthClientId: 'paid', organizationId });
    expect(
      await grants().acceptTerms({
        oauthClientId: 'paid',
        organizationId,
        shownTerms: shown,
      })
    ).toBe(false);
  });

  it('an unregistered client records nothing whatever was shown', async () => {
    await grants().setCap({
      oauthClientId: 'unregistered',
      organizationId,
      monthlyCapMicros: 10_000_000,
      shownTerms: shown,
    });
    expect(
      (await grants().getStanding('unregistered', organizationId))?.accepted
    ).toEqual({ marginBps: 0, skuPrices: {} });
  });
});
