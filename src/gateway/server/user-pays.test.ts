/**
 * User-pays submits on the real migrations: the grant, the cap, the app, and
 * the caller's grant read. `osk_` callers (no client) are unaffected.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  creditReservations,
  credits,
  gatewayApps,
  gatewayGrants,
  gatewayJobs,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { micros } from '@/billing/money';
import { gatewayJobRequestSchema } from '@/gateway/schema';
import type { GatewayGenerationWorkflowInput } from './workflows/gateway-generation-workflow';

let db: Database;
let closeDb: () => Promise<void>;

const triggerWorkflow = vi.fn(
  async (
    _path: string,
    _payload: GatewayGenerationWorkflowInput,
    _opts?: { deduplicationId?: string }
  ) => 'run-1'
);

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/cast/server/upload-check', () => ({
  requireCheckedUploadRights: vi.fn(async () => new Map()),
}));
vi.doMock('@/cast/server/upload-rights', () => ({
  likenessFromLedger: vi.fn(async () => 'none' as const),
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
vi.doMock('@/gateway/server/models', async () => ({
  ...(await vi.importActual<object>('@/gateway/server/models')),
  gatewayVias: () => ({ byteplus: false }),
}));

const { submitGatewayJob } = await import('./submit-job');
const { settleGatewayJob } = await import('./settle');
const { readGatewayGrant } = await import('./read-grant');
const { userPaysClientId } = await import('./errors');
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { toWorkflowScopedDb } =
  await import('@/platform/server/db/scoped-workflow');

const organizationId = generateId();
const appOrganizationId = generateId();
const userId = generateId();
const CLIENT = 'client-up';
const request = { ipAddress: '203.0.113.9', userAgent: 'vitest' };

const IMAGE = gatewayJobRequestSchema.parse({
  kind: 'image',
  model: 'gpt_image_2',
  prompt: 'a fox',
});

function ctx(
  oauthClientId: string | null,
  idempotencyKey: string | null = null
) {
  return {
    scopedDb: createScopedDb(organizationId, userId),
    request,
    idempotencyKey,
    oauthClientId,
  };
}

/** The submit's outcome as the API answers it. */
async function submitResponse(oauthClientId: string | null) {
  return runApiV1Handler(async () => {
    await submitGatewayJob(IMAGE, ctx(oauthClientId));
    return Response.json({}, { status: 202 });
  });
}

type ErrorBody = {
  error: { code: string; details?: Record<string, unknown> };
};

async function errorOf(response: Response): Promise<ErrorBody['error']> {
  const body: ErrorBody = await response.json();
  return body.error;
}

async function setGrant(
  monthlyCapMicros: number,
  revokedAt: Date | null = null
) {
  await db.delete(gatewayGrants);
  await db.insert(gatewayGrants).values({
    oauthClientId: CLIENT,
    userId,
    organizationId,
    monthlyCapMicros,
    revokedAt,
  });
}

async function spend(amount: number) {
  const transactionId = generateId();
  await db.insert(transactions).values({
    id: transactionId,
    organizationId,
    type: 'credit_usage',
    amount: -amount,
    balanceAfter: 0,
  });
  await db.insert(chargeLines).values({
    organizationId,
    transactionId,
    kind: 'provider_cost',
    amountMicros: amount,
    oauthClientId: CLIENT,
  });
}

async function nothingLeftBehind() {
  expect(await db.select().from(gatewayJobs)).toEqual([]);
  expect(await db.select().from(creditReservations)).toEqual([]);
  expect(triggerWorkflow).not.toHaveBeenCalled();
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: 't' },
    { id: appOrganizationId, name: 'A', slug: 'a' },
  ]);
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(chargeLines);
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(gatewayJobs);
  await db.delete(gatewayApps);
  await db.delete(credits);
  await db.insert(credits).values({ organizationId, balance: 100_000_000 });
  await setGrant(50_000_000);
});

describe('a user-pays submit', () => {
  it('holds under a live grant and stamps the client on the hold', async () => {
    const { job } = await submitGatewayJob(IMAGE, ctx(CLIENT));
    const [hold] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, job.reservationId ?? ''));
    expect(hold).toMatchObject({ oauthClientId: CLIENT, appId: null });
    expect(triggerWorkflow.mock.lastCall?.[1]).toMatchObject({
      oauthClientId: CLIENT,
      appId: null,
    });
  });

  it('is refused with GRANT_REQUIRED when there is no grant, leaving nothing', async () => {
    await db.delete(gatewayGrants);
    const response = await submitResponse(CLIENT);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'GRANT_REQUIRED' },
    });
    await nothingLeftBehind();
  });

  it('is refused once the grant is revoked, whatever the token says', async () => {
    await setGrant(50_000_000, new Date());
    const response = await submitResponse(CLIENT);
    expect((await errorOf(response)).code).toBe('GRANT_REQUIRED');
    await nothingLeftBehind();
  });

  it('is refused with SPEND_CAP_EXCEEDED and the numbers when the cap is spent', async () => {
    await setGrant(1_000_000);
    await spend(1_000_000);
    const response = await submitResponse(CLIENT);
    expect(response.status).toBe(402);
    const error = await errorOf(response);
    expect(error.code).toBe('SPEND_CAP_EXCEEDED');
    expect(error.details).toMatchObject({
      monthlyCapMicros: 1_000_000,
      spentMicros: 1_000_000,
      heldMicros: 0,
      remainingMicros: 0,
      requestedMicros: expect.any(Number),
    });
    await nothingLeftBehind();
  });

  it('is INSUFFICIENT_CREDITS, not a cap refusal, when the wallet is short', async () => {
    await db
      .update(credits)
      .set({ balance: 0 })
      .where(eq(credits.organizationId, organizationId));
    const response = await submitResponse(CLIENT);
    expect(response.status).toBe(402);
    expect((await errorOf(response)).code).toBe('INSUFFICIENT_CREDITS');
    await nothingLeftBehind();
  });

  it("is refused with APP_SUSPENDED for a suspended app's client", async () => {
    await db.insert(gatewayApps).values({
      organizationId: appOrganizationId,
      oauthClientId: CLIENT,
      name: 'App',
      status: 'suspended',
      createdByUserId: userId,
    });
    const response = await submitResponse(CLIENT);
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('APP_SUSPENDED');
    await nothingLeftBehind();
  });

  it('stamps an active app on the hold, the payload and the settled lines', async () => {
    const [app] = await db
      .insert(gatewayApps)
      .values({
        organizationId: appOrganizationId,
        oauthClientId: CLIENT,
        name: 'App',
        createdByUserId: userId,
      })
      .returning();
    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(IMAGE, {
      ...ctx(CLIENT),
      scopedDb,
    });
    const payload = triggerWorkflow.mock.lastCall?.[1];
    if (!payload || !app) throw new Error('expected a run and an app');
    expect(payload.appId).toBe(app.id);
    const [hold] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, job.reservationId ?? ''));
    expect(hold?.appId).toBe(app.id);

    const run = toWorkflowScopedDb(scopedDb);
    await run.gatewayJobs.markRunning(job.id);
    const output = {
      url: '/r2/a.png',
      path: 'a.png',
      contentType: 'image/png',
    };
    await run.gatewayJobs.recordOutputs(job.id, {
      outputs: [output],
      via: 'fal',
    });
    await settleGatewayJob({
      scopedDb: run,
      jobId: job.id,
      model: 'gpt_image_2',
      reservationId: payload.reservationId,
      costMicros: micros(4_000),
      estimateMicros: payload.estimateMicros,
      platformFeeBps: payload.platformFeeBps,
      oauthClientId: payload.oauthClientId,
      appId: payload.appId,
      usedOwnKey: false,
      idempotencyKey: `${job.id}:gateway-settle`,
      result: { outputs: [output], via: 'fal' },
    });
    const lines = await db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.gatewayJobId, job.id));
    expect(lines).toEqual([
      expect.objectContaining({ oauthClientId: CLIENT, appId: app.id }),
    ]);
  });
});

describe('an app-pays submit', () => {
  it('needs no grant and ignores apps and caps', async () => {
    await db.delete(gatewayGrants);
    await db.insert(gatewayApps).values({
      organizationId: appOrganizationId,
      oauthClientId: CLIENT,
      name: 'App',
      status: 'suspended',
      createdByUserId: userId,
    });
    const { job } = await submitGatewayJob(IMAGE, ctx(null));
    const [hold] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.id, job.reservationId ?? ''));
    expect(hold).toMatchObject({ oauthClientId: null, appId: null });
  });
});

describe('userPaysClientId', () => {
  it('is null for an osk_ key and refuses a token that names no client', () => {
    expect(userPaysClientId(null)).toBeNull();
    expect(userPaysClientId({ clientId: 'c' })).toBe('c');
    expect(() => userPaysClientId({ clientId: null })).toThrow(
      expect.objectContaining({ code: 'GRANT_REQUIRED' })
    );
  });
});

describe('readGatewayGrant', () => {
  const now = new Date('2026-11-11T12:00:00Z');

  it("reads the OAuth caller's cap, spend and what remains for the month", async () => {
    await spend(2_000_000);
    const document = await readGatewayGrant(
      createScopedDb(organizationId, userId),
      CLIENT,
      now
    );
    expect(document).toMatchObject({
      payer: 'user',
      organizationId,
      clientId: CLIENT,
      monthlyCapMicros: 50_000_000,
      heldMicros: 0,
      periodStart: '2026-11-01T00:00:00.000Z',
      periodEnd: '2026-12-01T00:00:00.000Z',
      _links: { self: { href: '/api/v1/gateway/grant' } },
    });
  });

  it('reads "app pays" for an osk_ key', async () => {
    const document = await readGatewayGrant(
      createScopedDb(organizationId, userId),
      null,
      now
    );
    expect(document).toMatchObject({
      payer: 'app',
      clientId: null,
      monthlyCapMicros: null,
      spentMicros: null,
      remainingMicros: null,
    });
  });

  it('refuses an OAuth caller with no live grant', async () => {
    await setGrant(5_000_000, new Date());
    await expect(
      readGatewayGrant(createScopedDb(organizationId, userId), CLIENT, now)
    ).rejects.toMatchObject({ code: 'GRANT_REQUIRED', statusCode: 403 });
  });
});
