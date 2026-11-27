import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { micros } from '@/billing/money';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  credits,
  gatewayJobs,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';
import { createBillingMethods } from './billing';

let db: Database;
let close: () => Promise<void>;
const organizationId = generateId();
const otherOrganizationId = generateId();
const userId = generateId();

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
  for (const id of [organizationId, otherOrganizationId]) {
    await db.insert(organization).values({ id, name: 'T', slug: id });
    await db
      .insert(credits)
      .values({ organizationId: id, balance: 10_000_000 });
  }
});
afterAll(async () => close());

async function settle(
  orgId: string,
  key: string,
  lines: { kind: 'provider_cost' | 'platform_fee'; amount: number }[],
  attribution: { gatewayJobId?: string; sku?: string }
) {
  const billing = createBillingMethods(db, orgId, userId);
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  const held = await billing.createReservation(micros(total), {
    idempotencyKey: `${key}:hold`,
  });
  if (!held.ok) throw new Error('no hold');
  await billing.settleReservation(
    held.reservationId,
    lines.map((line) => ({
      kind: line.kind,
      amountMicros: micros(line.amount),
      payeeOrganizationId: null,
      sku: attribution.sku ?? null,
    })),
    {
      idempotencyKey: key,
      attribution: { gatewayJobId: attribution.gatewayJobId ?? null },
    }
  );
}

describe('getGatewaySpend', () => {
  it('groups the lines the organization paid by day and model, media and text, and agrees with its debits', async () => {
    const jobId = generateId();
    await db.insert(gatewayJobs).values({
      id: jobId,
      organizationId,
      userId,
      kind: 'image',
      modelKey: 'grok-imagine-image',
      input: { prompt: 'Mara' },
    });
    await settle(
      organizationId,
      'media',
      [
        { kind: 'provider_cost', amount: 20_000 },
        { kind: 'platform_fee', amount: 500 },
      ],
      { gatewayJobId: jobId }
    );
    await settle(
      organizationId,
      'text-1',
      [{ kind: 'provider_cost', amount: 2_000 }],
      { sku: 'openrouter/anthropic/claude-sonnet-5.5' }
    );
    await settle(
      organizationId,
      'text-2',
      [{ kind: 'provider_cost', amount: 3_000 }],
      { sku: 'openrouter/anthropic/claude-sonnet-5.5' }
    );
    // Another organization's spend and a line before the range stay out.
    await settle(
      otherOrganizationId,
      'other',
      [{ kind: 'provider_cost', amount: 9_000 }],
      { sku: 'openrouter/anthropic/claude-sonnet-5.5' }
    );
    await settle(
      organizationId,
      'old',
      [{ kind: 'provider_cost', amount: 7_000 }],
      { sku: 'openrouter/old' }
    );
    const old = new Date('2026-01-01T00:00:00Z');
    await db
      .update(chargeLines)
      .set({ createdAt: old })
      .where(eq(chargeLines.sku, 'openrouter/old'));

    const billing = createBillingMethods(db, organizationId, userId);
    const since = new Date(Date.now() - 86_400_000);
    const rows = await billing.getGatewaySpend(since);
    const today = new Date().toISOString().slice(0, 10);

    expect(rows).toEqual([
      {
        day: today,
        model: 'grok-imagine-image',
        totalMicros: 20_500,
        platformFeeMicros: 500,
        calls: 1,
      },
      {
        day: today,
        model: 'openrouter/anthropic/claude-sonnet-5.5',
        totalMicros: 5_000,
        platformFeeMicros: 0,
        calls: 2,
      },
    ]);

    // The Transactions page shows these debits; the view's total is theirs.
    const debits = await db
      .select({ amount: transactions.amount })
      .from(transactions)
      .where(eq(transactions.organizationId, organizationId));
    const recent = debits.reduce((sum, row) => sum - row.amount, 0) - 7_000;
    expect(rows.reduce((sum, row) => sum + row.totalMicros, 0)).toBe(recent);
  });
});
