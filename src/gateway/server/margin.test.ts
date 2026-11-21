/**
 * The app margin on the real migrations: which callers earn one, how much
 * (the lower of the app's margin and the user's accepted one), the hold and
 * the settle carrying the same line, short capture cutting it first, its
 * earning row, the estimate endpoint (the submit's lines and refusals, with
 * nothing written, held or checked), and job isolation between clients.
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
  gatewayEarnings,
  gatewayGrants,
  gatewayJobs,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import { NotFoundError } from '@/platform/errors';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { micros, type Microdollars } from '@/billing/money';
import { gatewayCharge } from '@/gateway/charge-lines';
import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import type { GatewayModel } from '@/gateway/server/catalog';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import type { GatewayGenerationWorkflowInput } from './workflows/gateway-generation-workflow';

let db: Database;
let closeDb: () => Promise<void>;

const SOURCE = {
  url: 'https://docs.example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-01T00:00:00.000Z',
};
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    duration: { type: 'number' },
    image_url: { type: 'string' },
  },
  required: ['prompt', 'duration'],
};

const MODELS: Record<string, GatewayModel> = {
  // $0.08 a second, read off the request.
  'grok-imagine-video': {
    provider: 'grok',
    id: 'grok-imagine-video',
    name: 'Grok Imagine Video',
    kind: 'video',
    endpointId: 'v1/videos/generations',
    card: rateCardSchema.parse({
      inputs: {
        duration: { param: 'duration', bound: 'request', kind: 'number' },
      },
      tables: {},
      price: { '*': [{ var: 'duration' }, 0.08] },
      examples: [],
      source: SOURCE,
    }),
    inputSchema: INPUT_SCHEMA,
  },
  // Priced on a count only the provider knows, with no estimate.
  'grok-imagine-tokens': {
    provider: 'grok',
    id: 'grok-imagine-tokens',
    name: 'Grok Imagine Tokens',
    kind: 'image',
    endpointId: 'v1/images/generations',
    card: rateCardSchema.parse({
      inputs: {
        output_tokens: {
          param: 'output_tokens',
          bound: 'usage',
          kind: 'number',
        },
      },
      tables: {},
      price: { '*': [{ var: 'output_tokens' }, 0.00001] },
      examples: [],
      source: SOURCE,
    }),
    inputSchema: INPUT_SCHEMA,
  },
};

const getGatewayModel = vi.fn(
  async (_provider: GatewayProvider, id: string) => {
    const model = MODELS[id];
    if (!model) throw new NotFoundError('Unknown model');
    return model;
  }
);
const requireCheckedUploadRights = vi.fn(
  async (_scopedDb: unknown, _urls: string[], _request: unknown) => new Map()
);
const triggerWorkflow = vi.fn(
  async (
    _path: string,
    _payload: GatewayGenerationWorkflowInput,
    _opts?: { deduplicationId?: string }
  ) => 'run-1'
);

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/cast/server/upload-check', () => ({ requireCheckedUploadRights }));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));
vi.doMock('@/gateway/server/catalog', () => ({ getGatewayModel }));

const { submitGatewayJob } = await import('./submit-job');
const { settleGatewayJob } = await import('./settle');
const { estimateGatewayJob } = await import('./estimate-job');
const { readGatewayJob } = await import('./read-job');
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { toWorkflowScopedDb } =
  await import('@/platform/server/db/scoped-workflow');

const payerId = generateId();
const appOrganizationId = generateId();
const userId = generateId();
const CLIENT = 'client-margin';
const request = { ipAddress: '203.0.113.9', userAgent: 'vitest' };
const PROMPT = 'Mara, a ferry mechanic, wipes her hands on a rag';
const BODY: GatewayJobInput = { prompt: PROMPT, duration: 5 };
// 5 seconds at $0.08.
const ESTIMATE = 400_000;
const VIDEO = {
  provider: 'grok',
  modelId: 'grok-imagine-video',
  body: BODY,
} as const;
const BALANCE = 100_000_000;

const scoped = () => createScopedDb(payerId, userId);

function ctx(
  oauthClientId: string | null,
  idempotencyKey: string | null = null
) {
  return { scopedDb: scoped(), request, idempotencyKey, oauthClientId };
}

let appId = '';

async function setApp(
  marginBps: number,
  opts: { status?: 'active' | 'suspended'; organizationId?: string } = {}
) {
  await db.delete(gatewayApps);
  const [app] = await db
    .insert(gatewayApps)
    .values({
      organizationId: opts.organizationId ?? appOrganizationId,
      oauthClientId: CLIENT,
      name: 'App',
      status: opts.status ?? 'active',
      createdByUserId: userId,
      marginBps,
    })
    .returning();
  appId = app?.id ?? '';
}

async function setGrant(acceptedMarginBps: number) {
  await db.delete(gatewayGrants);
  await db.insert(gatewayGrants).values({
    oauthClientId: CLIENT,
    userId,
    organizationId: payerId,
    monthlyCapMicros: 50_000_000,
    acceptedMarginBps,
  });
}

async function holdOf(reservationId: string | null) {
  const [hold] = await db
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.id, reservationId ?? ''));
  return hold;
}

function lastPayload(): GatewayGenerationWorkflowInput {
  const payload = triggerWorkflow.mock.lastCall?.[1];
  if (!payload) throw new Error('expected a run');
  return payload;
}

/** Records outputs and settles the run the way the workflow does. */
async function finish(
  jobId: string,
  payload: GatewayGenerationWorkflowInput,
  costMicros: Microdollars
) {
  const run = toWorkflowScopedDb(scoped());
  const output = { url: '/r2/a.mp4', path: 'a.mp4', contentType: 'video/mp4' };
  await run.gatewayJobs.markRunning(jobId);
  await run.gatewayJobs.recordOutputs(jobId, { outputs: [output], via: 'xai' });
  return settleGatewayJob({
    scopedDb: run,
    jobId,
    model: 'grok/grok-imagine-video',
    reservationId: payload.reservationId,
    costMicros,
    estimateMicros: payload.estimateMicros,
    platformFeeBps: payload.platformFeeBps,
    oauthClientId: payload.oauthClientId,
    appId: payload.appId,
    appMargin: payload.appMargin,
    usedOwnKey: false,
    idempotencyKey: `${jobId}:gateway-settle`,
    result: { outputs: [output], via: 'xai' },
  });
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(organization).values([
    { id: payerId, name: 'Payer', slug: 'payer' },
    { id: appOrganizationId, name: 'Maker', slug: 'maker' },
  ]);
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(gatewayEarnings);
  await db.delete(gatewayApps);
  await db.delete(chargeLines);
  await db.delete(transactions);
  await db.delete(creditReservations);
  await db.delete(gatewayJobs);
  await db.delete(credits);
  await db
    .insert(credits)
    .values({ organizationId: payerId, balance: BALANCE });
  await setApp(2000);
  await setGrant(2000);
});

describe('which margin a user-pays submit applies', () => {
  it.each([
    ['the accepted margin', 2000, 2000, 2000],
    ['a lowered margin at once', 1000, 2000, 1000],
    ['only the accepted margin when the app raised it', 3000, 2000, 2000],
    ['none on a grant from before margins', 2000, 0, 0],
  ])('applies %s', async (_name, appBps, acceptedBps, applied) => {
    await setApp(appBps);
    await setGrant(acceptedBps);
    const { job } = await submitGatewayJob(VIDEO, ctx(CLIENT));
    const payload = lastPayload();
    expect(payload.appMargin).toEqual(
      applied > 0
        ? { bps: applied, payeeOrganizationId: appOrganizationId }
        : null
    );
    // The hold includes the margin, so the cap guard counts it.
    const expected = gatewayCharge({
      providerCostMicros: payload.estimateMicros,
      platformFeeBps: payload.platformFeeBps,
      ...(payload.appMargin && { appMargin: payload.appMargin }),
    }).totalMicros;
    expect((await holdOf(job.reservationId))?.originalAmount).toBe(expected);
    expect(payload.estimateMicros).toBe(ESTIMATE);
    expect(expected).toBe(ESTIMATE + (ESTIMATE * applied) / 10_000);
    // The hold carries the client and the app, so the cap guard counts it.
    expect(await holdOf(job.reservationId)).toMatchObject({
      oauthClientId: CLIENT,
      appId,
    });
  });

  it('refuses a hold whose margin takes it past the cap', async () => {
    // Room for the provider cost alone, not for the 20% on top.
    await db
      .update(gatewayGrants)
      .set({ monthlyCapMicros: ESTIMATE })
      .where(eq(gatewayGrants.oauthClientId, CLIENT));
    const response = await runApiV1Handler(async () => {
      await submitGatewayJob(VIDEO, ctx(CLIENT));
      return Response.json({});
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'SPEND_CAP_EXCEEDED',
        details: { remainingMicros: ESTIMATE, requestedMicros: 480_000 },
      },
    });
    expect(await db.select().from(gatewayJobs)).toEqual([]);
    expect(await db.select().from(creditReservations)).toEqual([]);
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });

  it('applies none for an osk_ key, even when a registered app exists', async () => {
    await submitGatewayJob(VIDEO, ctx(null));
    expect(lastPayload()).toMatchObject({ appId: null, appMargin: null });
  });

  it('applies none for a client that is not a registered app', async () => {
    await db.delete(gatewayApps);
    await submitGatewayJob(VIDEO, ctx(CLIENT));
    expect(lastPayload()).toMatchObject({ appId: null, appMargin: null });
  });

  it("applies none when the payer is the app's own organization", async () => {
    await setApp(2000, { organizationId: payerId });
    await submitGatewayJob(VIDEO, ctx(CLIENT));
    expect(lastPayload()).toMatchObject({ appId, appMargin: null });
  });

  it('refuses a suspended app', async () => {
    await setApp(2000, { status: 'suspended' });
    const response = await runApiV1Handler(async () => {
      await submitGatewayJob(VIDEO, ctx(CLIENT));
      return Response.json({});
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'APP_SUSPENDED' },
    });
    expect(await db.select().from(gatewayJobs)).toEqual([]);
    expect(await db.select().from(creditReservations)).toEqual([]);
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });
});

describe('settling with a margin', () => {
  it('writes the margin line to the app and a pending earning of the same amount', async () => {
    const { job } = await submitGatewayJob(VIDEO, ctx(CLIENT));
    const payload = lastPayload();
    const cost = micros(10_000);
    const charged = await finish(job.id, payload, cost);
    expect(charged).toBe(12_000);
    const lines = await db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.gatewayJobId, job.id));
    const margin = lines.find((line) => line.kind === 'app_margin');
    expect(margin).toMatchObject({
      amountMicros: 2_000,
      payeeOrganizationId: appOrganizationId,
      appId,
      oauthClientId: CLIENT,
    });
    // The lines sum to the wallet debit.
    expect(lines.reduce((sum, line) => sum + line.amountMicros, 0)).toBe(
      12_000
    );
    const [debit] = await db.select().from(transactions);
    expect(debit?.amount).toBe(-12_000);
    expect(await db.select().from(gatewayEarnings)).toEqual([
      expect.objectContaining({
        chargeLineId: margin?.id,
        payerOrganizationId: payerId,
        payeeOrganizationId: appOrganizationId,
        appId,
        amountMicros: 2_000,
        status: 'pending',
      }),
    ]);
  });

  it('settles at the snapshotted margin even after the app raises it', async () => {
    const { job } = await submitGatewayJob(VIDEO, ctx(CLIENT));
    await db
      .update(gatewayApps)
      .set({ marginBps: 5000 })
      .where(eq(gatewayApps.id, appId));
    await finish(job.id, lastPayload(), micros(10_000));
    const [earning] = await db.select().from(gatewayEarnings);
    expect(earning?.amountMicros).toBe(2_000);
  });

  it('a short capture cuts the margin first, and the earning matches the cut line', async () => {
    const { job } = await submitGatewayJob(VIDEO, ctx(CLIENT));
    const payload = lastPayload();
    const hold = (await holdOf(job.reservationId))?.originalAmount ?? 0;
    // Nothing beyond the hold can be paid.
    await db
      .update(credits)
      .set({ balance: hold })
      .where(eq(credits.organizationId, payerId));
    // Provider cost above the estimate: the full charge is past the hold.
    const cost = micros(Math.round(payload.estimateMicros * 1.1));
    const charged = await finish(job.id, payload, cost);
    expect(charged).toBe(hold);
    const lines = await db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.gatewayJobId, job.id));
    const provider = lines.find((line) => line.kind === 'provider_cost');
    const margin = lines.find((line) => line.kind === 'app_margin');
    expect(provider?.amountMicros).toBe(cost);
    expect(margin?.amountMicros).toBe(hold - cost);
    expect(lines.reduce((sum, line) => sum + line.amountMicros, 0)).toBe(hold);
    const earnings = await db.select().from(gatewayEarnings);
    expect(earnings.map((row) => row.amountMicros)).toEqual([hold - cost]);
  });

  it('a capture that only covers the provider writes no margin line and no earning', async () => {
    const { job } = await submitGatewayJob(VIDEO, ctx(CLIENT));
    const payload = lastPayload();
    const hold = (await holdOf(job.reservationId))?.originalAmount ?? 0;
    await db
      .update(credits)
      .set({ balance: hold })
      .where(eq(credits.organizationId, payerId));
    await finish(job.id, payload, micros(hold));
    const kinds = (
      await db
        .select()
        .from(chargeLines)
        .where(eq(chargeLines.gatewayJobId, job.id))
    ).map((line) => line.kind);
    expect(kinds).toEqual(['provider_cost']);
    expect(await db.select().from(gatewayEarnings)).toEqual([]);
  });

  it("an app's own organization pays no margin and earns nothing", async () => {
    await setApp(2000, { organizationId: payerId });
    const { job } = await submitGatewayJob(VIDEO, ctx(CLIENT));
    expect((await holdOf(job.reservationId))?.originalAmount).toBe(ESTIMATE);
    expect(await finish(job.id, lastPayload(), micros(10_000))).toBe(10_000);
    const lines = await db.select().from(chargeLines);
    expect(lines.map((line) => line.kind)).toEqual(['provider_cost']);
    expect(await db.select().from(gatewayEarnings)).toEqual([]);
  });

  it('an osk_ job writes no payee line and no earning', async () => {
    const { job } = await submitGatewayJob(VIDEO, ctx(null));
    await finish(job.id, lastPayload(), micros(10_000));
    const lines = await db.select().from(chargeLines);
    expect(lines.every((line) => line.payeeOrganizationId === null)).toBe(true);
    expect(await db.select().from(gatewayEarnings)).toEqual([]);
  });
});

describe('estimateGatewayJob', () => {
  const estimateFor = (
    oauthClientId: string | null,
    job: {
      provider: GatewayProvider;
      modelId: string;
      body: GatewayJobInput;
    } = VIDEO
  ) => estimateGatewayJob(job, { scopedDb: scoped(), oauthClientId });

  async function nothingWrittenHeldOrChecked() {
    expect(await db.select().from(creditReservations)).toEqual([]);
    expect(await db.select().from(gatewayJobs)).toEqual([]);
    expect(await db.select().from(transactions)).toEqual([]);
    expect(triggerWorkflow).not.toHaveBeenCalled();
    expect(requireCheckedUploadRights).not.toHaveBeenCalled();
  }

  it('prices the job as lines for this caller and reserves nothing', async () => {
    const estimate = await estimateFor(CLIENT);
    expect(estimate.lines).toEqual([
      { kind: 'provider_cost', amountMicros: ESTIMATE },
      { kind: 'app_margin', amountMicros: 80_000 },
    ]);
    expect(estimate).toMatchObject({
      payer: 'user',
      provider: 'grok',
      model: 'grok-imagine-video',
      kind: 'video',
      totalMicros: 480_000,
      remainingMicros: 50_000_000,
      fitsUnderCap: true,
    });
    expect(estimate.totalMicros).toBe(
      estimate.lines.reduce((sum, line) => sum + line.amountMicros, 0)
    );
    expect(estimate._links.self?.href).toBe(
      '/api/v1/gateway/estimate/{provider}/{model}'
    );
    await nothingWrittenHeldOrChecked();
  });

  it.each([
    ['the accepted margin', 2000, 2000, CLIENT],
    ['a lowered margin', 1000, 2000, CLIENT],
    ['only the accepted margin when the app raised it', 3000, 2000, CLIENT],
    ['no margin on a grant from before margins', 2000, 0, CLIENT],
    ['no margin for an osk_ key', 2000, 2000, null],
  ])(
    'returns the lines the submit holds: %s',
    async (_name, appBps, acceptedBps, client) => {
      await setApp(appBps);
      await setGrant(acceptedBps);
      const estimate = await estimateFor(client);
      await nothingWrittenHeldOrChecked();

      const { job } = await submitGatewayJob(VIDEO, ctx(client));
      const payload = lastPayload();
      expect((await holdOf(job.reservationId))?.originalAmount).toBe(
        estimate.totalMicros
      );
      const held = gatewayCharge({
        providerCostMicros: payload.estimateMicros,
        platformFeeBps: payload.platformFeeBps,
        ...(payload.appMargin && { appMargin: payload.appMargin }),
      });
      expect(estimate.lines).toEqual(
        held.lines.map(({ kind, amountMicros }) => ({ kind, amountMicros }))
      );
    }
  );

  it("shows no margin when the payer is the app's own organization", async () => {
    await setApp(2000, { organizationId: payerId });
    const estimate = await estimateFor(CLIENT);
    expect(estimate.lines).toEqual([
      { kind: 'provider_cost', amountMicros: ESTIMATE },
    ]);
    expect(estimate).toMatchObject({ payer: 'user', totalMicros: ESTIMATE });
  });

  it('says when the hold would not fit under the cap, and still reserves nothing', async () => {
    await db
      .update(gatewayGrants)
      .set({ monthlyCapMicros: ESTIMATE })
      .where(eq(gatewayGrants.oauthClientId, CLIENT));
    expect(await estimateFor(CLIENT)).toMatchObject({
      totalMicros: 480_000,
      remainingMicros: ESTIMATE,
      fitsUnderCap: false,
    });
    await nothingWrittenHeldOrChecked();
  });

  it('shows no margin and no cap for an osk_ key', async () => {
    const estimate = await estimateFor(null);
    expect(estimate.lines.map((line) => line.kind)).toEqual(['provider_cost']);
    expect(estimate).toMatchObject({
      payer: 'app',
      remainingMicros: null,
      fitsUnderCap: null,
    });
  });

  it('makes no upload check: the URLs in the body wait for the submit', async () => {
    const withStill = {
      ...VIDEO,
      body: { ...BODY, image_url: 'https://cdn.example.com/mara.png' },
    };
    await estimateFor(CLIENT, withStill);
    await nothingWrittenHeldOrChecked();
    // The submit of the same body does check it.
    await submitGatewayJob(withStill, ctx(CLIENT));
    expect(requireCheckedUploadRights.mock.lastCall?.[1]).toEqual([
      'https://cdn.example.com/mara.png',
    ]);
  });

  it.each([
    [
      'a body the model schema refuses',
      { ...VIDEO, body: { prompt: PROMPT } },
      'VALIDATION_ERROR',
    ],
    [
      'a request the card cannot price',
      { ...VIDEO, modelId: 'grok-imagine-tokens' },
      'VALIDATION_ERROR',
    ],
    [
      'inline media',
      { ...VIDEO, body: { ...BODY, image_url: 'data:image/png;base64,AAAA' } },
      'VALIDATION_ERROR',
    ],
    ['an unknown model', { ...VIDEO, modelId: 'no-such-model' }, 'NOT_FOUND'],
  ])('refuses %s exactly as the submit does', async (_name, job, code) => {
    for (const client of [CLIENT, null]) {
      const estimated = await estimateFor(client, job).catch((e: unknown) => e);
      const submitted = await submitGatewayJob(job, ctx(client)).catch(
        (e: unknown) => e
      );
      expect(estimated).toMatchObject({ code });
      expect(estimated).toEqual(submitted);
    }
    await nothingWrittenHeldOrChecked();
  });

  it('refuses an OAuth caller with no grant', async () => {
    await db.delete(gatewayGrants);
    await expect(estimateFor(CLIENT)).rejects.toMatchObject({
      code: 'GRANT_REQUIRED',
      statusCode: 403,
    });
    await nothingWrittenHeldOrChecked();
  });

  it('refuses an OAuth caller whose grant is revoked', async () => {
    await db.update(gatewayGrants).set({ revokedAt: new Date() });
    await expect(estimateFor(CLIENT)).rejects.toMatchObject({
      code: 'GRANT_REQUIRED',
    });
  });

  it("refuses a suspended app's client", async () => {
    await setApp(2000, { status: 'suspended' });
    await expect(estimateFor(CLIENT)).rejects.toMatchObject({
      code: 'APP_SUSPENDED',
      statusCode: 403,
    });
    await nothingWrittenHeldOrChecked();
  });
});

describe('job isolation between clients of one organization', () => {
  const read = (id: string, oauthClientId: string | null) =>
    runApiV1Handler(async () =>
      Response.json(
        await readGatewayJob(scoped(), id, {
          origin: 'https://openstory.test',
          waitMs: 0,
          oauthClientId,
        })
      )
    );

  it("another client reads a 404 for this client's job and for the organization's own", async () => {
    await db.insert(gatewayGrants).values({
      oauthClientId: 'other-client',
      userId,
      organizationId: payerId,
      monthlyCapMicros: 50_000_000,
    });
    const mine = await submitGatewayJob(VIDEO, ctx(CLIENT));
    const keyed = await submitGatewayJob(VIDEO, ctx(null));
    expect((await read(mine.job.id, CLIENT)).status).toBe(200);
    expect((await read(mine.job.id, 'other-client')).status).toBe(404);
    expect((await read(keyed.job.id, 'other-client')).status).toBe(404);
    expect((await read(mine.job.id, null)).status).toBe(200);
  });

  it("a colliding Idempotency-Key never replays another client's job", async () => {
    await db.insert(gatewayGrants).values({
      oauthClientId: 'other-client',
      userId,
      organizationId: payerId,
      monthlyCapMicros: 50_000_000,
    });
    const first = await submitGatewayJob(VIDEO, ctx(CLIENT, 'same'));
    const other = await submitGatewayJob(VIDEO, ctx('other-client', 'same'));
    const key = await submitGatewayJob(VIDEO, ctx(null, 'same'));
    expect(other.replay).toBe(false);
    expect(key.replay).toBe(false);
    expect(new Set([first.job.id, other.job.id, key.job.id]).size).toBe(3);
    const again = await submitGatewayJob(VIDEO, ctx(CLIENT, 'same'));
    expect(again).toMatchObject({ replay: true, job: { id: first.job.id } });
  });
});
