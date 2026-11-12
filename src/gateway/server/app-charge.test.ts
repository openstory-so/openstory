/**
 * `POST /api/v1/gateway/charges` on the real migrations: a registered app
 * charges the consenting user's organization for its own SKU, at a price
 * the user approved, under the cap, once per Idempotency-Key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  creditReservations,
  credits,
  gatewayAppSkus,
  gatewayApps,
  gatewayEarnings,
  gatewayGrants,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import type { SkuPrices } from '@/gateway/apps';

let db: Database;
let closeDb: () => Promise<void>;

vi.doMock('#db-client', () => ({ getDb: () => db }));

const { createAppCharge } = await import('./app-charge');
const { createScopedDb } = await import('@/platform/server/db/scoped');

const payerId = generateId();
const appOrganizationId = generateId();
const userId = generateId();
const CLIENT = 'client-charges';
const PRICE = 500_000;
let appId = '';

const scoped = (organizationId = payerId) =>
  createScopedDb(organizationId, userId);

function charge(
  input: Partial<{
    oauthClientId: string | null;
    idempotencyKey: string | null;
    sku: string;
    organizationId: string;
  }> = {}
) {
  return createAppCharge({
    scopedDb: scoped(input.organizationId),
    oauthClientId:
      input.oauthClientId === undefined ? CLIENT : input.oauthClientId,
    idempotencyKey:
      input.idempotencyKey === undefined ? 'charge-1' : input.idempotencyKey,
    sku: input.sku ?? 'export-hd',
  });
}

async function refusal(promise: Promise<unknown>) {
  const response = await runApiV1Handler(async () => {
    await promise;
    return Response.json({});
  });
  const body: { error: { code: string; message: string; details?: unknown } } =
    await response.json();
  return { status: response.status, ...body.error };
}

async function setGrant(
  skuPrices: SkuPrices,
  opts: { organizationId?: string; monthlyCapMicros?: number } = {}
) {
  await db.delete(gatewayGrants);
  await db.insert(gatewayGrants).values({
    oauthClientId: CLIENT,
    userId,
    organizationId: opts.organizationId ?? payerId,
    monthlyCapMicros: opts.monthlyCapMicros ?? 50_000_000,
    acceptedSkuPrices: skuPrices,
  });
}

async function nothingCharged() {
  expect(await db.select().from(transactions)).toEqual([]);
  expect(await db.select().from(chargeLines)).toEqual([]);
  const holds = await db.select().from(creditReservations);
  expect(holds.every((hold) => hold.remainingAmount === 0)).toBe(true);
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(organization).values([
    { id: payerId, name: 'Payer', slug: 'payer' },
    { id: appOrganizationId, name: 'Maker', slug: 'maker' },
  ]);
  const [app] = await db
    .insert(gatewayApps)
    .values({
      organizationId: appOrganizationId,
      oauthClientId: CLIENT,
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
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(gatewayAppSkus);
  await db.delete(credits);
  await db
    .update(gatewayApps)
    .set({ status: 'active', organizationId: appOrganizationId })
    .where(eq(gatewayApps.id, appId));
  await db.insert(credits).values([
    { organizationId: payerId, balance: 100_000_000 },
    { organizationId: appOrganizationId, balance: 100_000_000 },
  ]);
  await db.insert(gatewayAppSkus).values({
    appId,
    key: 'export-hd',
    name: 'HD export',
    priceMicros: PRICE,
  });
  await setGrant({ 'export-hd': PRICE });
});

describe('createAppCharge', () => {
  it("debits the price as one app_charge line to the app's organization, with a pending earning", async () => {
    const result = await charge();
    expect(result).toMatchObject({
      sku: 'export-hd',
      totalMicros: PRICE,
      lines: [{ kind: 'app_charge', amountMicros: PRICE }],
      replay: false,
    });
    const [line] = await db.select().from(chargeLines);
    expect(line).toMatchObject({
      organizationId: payerId,
      transactionId: result.id,
      kind: 'app_charge',
      amountMicros: PRICE,
      payeeOrganizationId: appOrganizationId,
      oauthClientId: CLIENT,
      appId,
      sku: 'export-hd',
      gatewayJobId: null,
    });
    expect(await db.select().from(gatewayEarnings)).toEqual([
      expect.objectContaining({
        chargeLineId: line?.id,
        payeeOrganizationId: appOrganizationId,
        amountMicros: PRICE,
        status: 'pending',
      }),
    ]);
    const [hold] = await db.select().from(creditReservations);
    expect(hold).toMatchObject({
      oauthClientId: CLIENT,
      appId,
      remainingAmount: 0,
    });
  });

  it('replays an Idempotency-Key without charging again, whatever the body', async () => {
    const first = await charge();
    await db
      .update(gatewayAppSkus)
      .set({ status: 'archived' })
      .where(eq(gatewayAppSkus.appId, appId));
    const again = await charge({ sku: 'something-else' });
    expect(again).toMatchObject({
      id: first.id,
      sku: 'export-hd',
      totalMicros: PRICE,
      replay: true,
    });
    expect(await db.select().from(transactions)).toHaveLength(1);
    expect(await db.select().from(gatewayEarnings)).toHaveLength(1);
  });

  it('is refused for an osk_ key, with a clear error', async () => {
    const error = await refusal(charge({ oauthClientId: null }));
    expect(error).toMatchObject({ status: 403, code: 'USER_PAYS_ONLY' });
    expect(error.message).toMatch(/osk_ key cannot charge/);
    await nothingCharged();
  });

  it('needs an Idempotency-Key', async () => {
    expect(await refusal(charge({ idempotencyKey: null }))).toMatchObject({
      status: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    await nothingCharged();
  });

  it('is refused past the monthly cap, counting the charge like a job', async () => {
    await setGrant({ 'export-hd': PRICE }, { monthlyCapMicros: 1_000_000 });
    await charge({ idempotencyKey: 'a' });
    await charge({ idempotencyKey: 'b' });
    const error = await refusal(charge({ idempotencyKey: 'c' }));
    expect(error).toMatchObject({ status: 402, code: 'SPEND_CAP_EXCEEDED' });
    expect(error.details).toMatchObject({
      monthlyCapMicros: 1_000_000,
      spentMicros: 1_000_000,
      requestedMicros: PRICE,
    });
    expect(await db.select().from(transactions)).toHaveLength(2);
  });

  it('is refused for an unknown or archived SKU', async () => {
    expect(await refusal(charge({ sku: 'nope' }))).toMatchObject({
      status: 404,
      code: 'UNKNOWN_SKU',
    });
    await db
      .update(gatewayAppSkus)
      .set({ status: 'archived' })
      .where(eq(gatewayAppSkus.appId, appId));
    expect((await refusal(charge())).code).toBe('UNKNOWN_SKU');
    await nothingCharged();
  });

  it('is refused above the accepted price, or for a SKU the user never approved', async () => {
    await db
      .update(gatewayAppSkus)
      .set({ priceMicros: PRICE + 1 })
      .where(eq(gatewayAppSkus.appId, appId));
    expect(await refusal(charge())).toMatchObject({
      status: 403,
      code: 'SKU_NOT_APPROVED',
      details: {
        sku: 'export-hd',
        priceMicros: PRICE + 1,
        acceptedPriceMicros: PRICE,
      },
    });
    await setGrant({});
    expect(await refusal(charge())).toMatchObject({
      code: 'SKU_NOT_APPROVED',
      details: { acceptedPriceMicros: null },
    });
    await nothingCharged();
  });

  it('charges a lowered price, never the accepted one', async () => {
    await db
      .update(gatewayAppSkus)
      .set({ priceMicros: PRICE - 100_000 })
      .where(eq(gatewayAppSkus.appId, appId));
    expect((await charge()).totalMicros).toBe(PRICE - 100_000);
  });

  it("is refused when the payer is the app's own organization", async () => {
    await setGrant(
      { 'export-hd': PRICE },
      { organizationId: appOrganizationId }
    );
    expect(
      await refusal(charge({ organizationId: appOrganizationId }))
    ).toMatchObject({ status: 403, code: 'OWN_ORGANIZATION' });
    await nothingCharged();
  });

  it('is refused for a client that is not a registered app, or a suspended one', async () => {
    await db.insert(gatewayGrants).values({
      oauthClientId: 'stranger',
      userId,
      organizationId: payerId,
      monthlyCapMicros: 50_000_000,
    });
    expect(await refusal(charge({ oauthClientId: 'stranger' }))).toMatchObject({
      status: 403,
      code: 'APP_NOT_REGISTERED',
    });
    await db
      .update(gatewayApps)
      .set({ status: 'suspended' })
      .where(eq(gatewayApps.id, appId));
    expect((await refusal(charge())).code).toBe('APP_SUSPENDED');
    await nothingCharged();
  });

  it('is refused without a live grant', async () => {
    await db.delete(gatewayGrants);
    expect((await refusal(charge())).code).toBe('GRANT_REQUIRED');
    await nothingCharged();
  });

  it('is INSUFFICIENT_CREDITS when the wallet cannot cover the price', async () => {
    await db
      .update(credits)
      .set({ balance: PRICE - 1 })
      .where(eq(credits.organizationId, payerId));
    expect(await refusal(charge())).toMatchObject({
      status: 402,
      code: 'INSUFFICIENT_CREDITS',
    });
    await nothingCharged();
  });
});
