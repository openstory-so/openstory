/**
 * App registration on the real migrations: only a client the user created
 * can be linked, once, and the submit's lookup finds it from any payer.
 */

import { createTestDb } from '@/platform/server/db/test-d1';
import type { Database } from '@/platform/server/db/client';
import { generateId } from '@/platform/id';
import {
  gatewayApps,
  gatewayGrants,
  oauthClient,
  organization,
  user,
} from '@/platform/server/db/schema';
import { ValidationError } from '@/platform/errors';
import { MAX_APP_MARGIN_BPS, MAX_APP_SKU_PRICE_MICROS } from '@/gateway/apps';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGatewayAppsMethods } from './gateway-apps';

let db: Database;
let closeDb: () => Promise<void>;
const userId = generateId();
const strangerId = generateId();
const organizationId = generateId();
const payerOrganizationId = generateId();

async function client(clientId: string, owner: string | null) {
  await db.insert(oauthClient).values({
    id: generateId(),
    clientId,
    userId: owner,
    redirectUris: ['https://app.example/cb'],
  });
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values([
    { id: userId, name: 'U', email: 'u@e.com' },
    { id: strangerId, name: 'S', email: 's@e.com' },
  ]);
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: 't' },
    { id: payerOrganizationId, name: 'P', slug: 'p' },
  ]);
  await client('mine', userId);
  await client('theirs', strangerId);
  await client('dynamic', null);
});

afterAll(async () => {
  await closeDb();
});

describe('gatewayApps', () => {
  const apps = () => createGatewayAppsMethods(db, organizationId, userId);

  it('registers a client the user created', async () => {
    const result = await apps().register({ oauthClientId: 'mine', name: 'A' });
    expect(result).toMatchObject({
      ok: true,
      app: {
        organizationId,
        oauthClientId: 'mine',
        name: 'A',
        status: 'active',
        createdByUserId: userId,
      },
    });
    expect((await apps().list()).map((app) => app.oauthClientId)).toEqual([
      'mine',
    ]);
  });

  it("cannot claim another user's client or an unowned one", async () => {
    expect(
      await apps().register({ oauthClientId: 'theirs', name: 'X' })
    ).toEqual({ ok: false, reason: 'not_owner' });
    expect(
      await apps().register({ oauthClientId: 'dynamic', name: 'X' })
    ).toEqual({ ok: false, reason: 'not_owner' });
    expect(
      await apps().register({ oauthClientId: 'unknown', name: 'X' })
    ).toEqual({ ok: false, reason: 'not_owner' });
    expect(await db.select().from(gatewayApps)).toHaveLength(1);
  });

  it('cannot register a client twice, from any organization', async () => {
    const elsewhere = createGatewayAppsMethods(db, payerOrganizationId, userId);
    expect(
      await elsewhere.register({ oauthClientId: 'mine', name: 'Again' })
    ).toEqual({ ok: false, reason: 'taken' });
  });

  it("finds a client's app from the payer's scope", async () => {
    const payer = createGatewayAppsMethods(db, payerOrganizationId, strangerId);
    expect(await payer.getByOAuthClient('mine')).toMatchObject({
      organizationId,
      status: 'active',
    });
    expect(await payer.getByOAuthClient('theirs')).toBeNull();
    expect(await payer.list()).toEqual([]);
  });
});

describe('margin and SKUs', () => {
  const apps = () => createGatewayAppsMethods(db, organizationId, userId);
  const appId = async () => {
    const app = await apps().getByOAuthClient('mine');
    if (!app) throw new Error('expected the registered app');
    return app.id;
  };
  const grantOf = async (id: string) => {
    const [row] = await db
      .select()
      .from(gatewayGrants)
      .where(eq(gatewayGrants.id, id));
    return row;
  };
  async function grant(acceptedMarginBps: number, skuPrices = {}) {
    const [row] = await db
      .insert(gatewayGrants)
      .values({
        oauthClientId: 'mine',
        userId: generateId(),
        organizationId: payerOrganizationId,
        monthlyCapMicros: 10_000_000,
        acceptedMarginBps,
        acceptedSkuPrices: skuPrices,
      })
      .returning();
    if (!row) throw new Error('expected a grant');
    return row.id;
  }

  it('bounds the margin to 0..MAX_APP_MARGIN_BPS in whole basis points', async () => {
    const id = await appId();
    for (const bad of [-1, MAX_APP_MARGIN_BPS + 1, 12.5]) {
      await expect(apps().setMargin(id, bad)).rejects.toBeInstanceOf(
        ValidationError
      );
    }
    expect(await apps().setMargin(id, MAX_APP_MARGIN_BPS)).toBe(true);
    expect((await apps().getByOAuthClient('mine'))?.marginBps).toBe(
      MAX_APP_MARGIN_BPS
    );
    expect(await apps().setMargin(id, 0)).toBe(true);
  });

  it("refuses another organization's app", async () => {
    const elsewhere = createGatewayAppsMethods(db, payerOrganizationId, userId);
    expect(await elsewhere.setMargin(await appId(), 100)).toBe(false);
    expect(
      await elsewhere.saveSku(await appId(), {
        key: 'hd',
        name: 'HD',
        priceMicros: 1,
      })
    ).toBeNull();
  });

  it('lowering the margin lowers what grants accepted; raising leaves them', async () => {
    const id = await appId();
    await apps().setMargin(id, 2000);
    const high = await grant(2000);
    const low = await grant(500);
    await apps().setMargin(id, 1000);
    expect((await grantOf(high))?.acceptedMarginBps).toBe(1000);
    expect((await grantOf(low))?.acceptedMarginBps).toBe(500);
    await apps().setMargin(id, 3000);
    expect((await grantOf(high))?.acceptedMarginBps).toBe(1000);
  });

  it('declares SKUs within the ceiling and shows active ones on the terms', async () => {
    const id = await appId();
    await expect(
      apps().saveSku(id, {
        key: 'hd',
        name: 'HD',
        priceMicros: MAX_APP_SKU_PRICE_MICROS + 1,
      })
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      apps().saveSku(id, { key: 'Bad Key', name: 'X', priceMicros: 1 })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await apps().saveSku(id, { key: 'hd', name: 'HD', priceMicros: 500_000 })
    ).toMatchObject({ key: 'hd', priceMicros: 500_000, status: 'active' });
    expect(await apps().getActiveSku(id, 'hd')).toMatchObject({
      priceMicros: 500_000,
    });
    expect(await apps().getTermsByOAuthClient('mine')).toMatchObject({
      appId: id,
      ownerOrganizationId: organizationId,
      ownerOrganizationName: 'T',
      skus: [{ key: 'hd', name: 'HD', priceMicros: 500_000 }],
    });
    expect(await apps().listSkus([id])).toHaveLength(1);
  });

  it('a lower price lowers accepted prices; archiving forgets them', async () => {
    const id = await appId();
    const accepted = await grant(0, { hd: 500_000, other: 9 });
    await apps().saveSku(id, { key: 'hd', name: 'HD', priceMicros: 400_000 });
    expect((await grantOf(accepted))?.acceptedSkuPrices).toEqual({
      hd: 400_000,
      other: 9,
    });
    await apps().saveSku(id, { key: 'hd', name: 'HD', priceMicros: 450_000 });
    expect((await grantOf(accepted))?.acceptedSkuPrices).toMatchObject({
      hd: 400_000,
    });
    expect(await apps().archiveSku(id, 'hd')).toBe(true);
    expect(await apps().getActiveSku(id, 'hd')).toBeNull();
    expect((await grantOf(accepted))?.acceptedSkuPrices).toEqual({ other: 9 });
    expect((await apps().getTermsByOAuthClient('mine'))?.skus).toEqual([]);
    expect(await apps().archiveSku(id, 'missing')).toBe(false);
  });

  it('a suspended app has no terms to show', async () => {
    await db
      .update(gatewayApps)
      .set({ status: 'suspended' })
      .where(eq(gatewayApps.oauthClientId, 'mine'));
    expect(await apps().getTermsByOAuthClient('mine')).toBeNull();
    await db
      .update(gatewayApps)
      .set({ status: 'active' })
      .where(eq(gatewayApps.oauthClientId, 'mine'));
  });
});
