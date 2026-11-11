/**
 * Submitting a gateway job on the real migrations: the hold, the trigger, a
 * replayed `Idempotency-Key`, a refusal for credits, the upload check before
 * anything spends, platform keys only, and another organization's job as a 404.
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
import { and, eq } from 'drizzle-orm';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  creditReservations,
  credits,
  gatewayGrants,
  gatewayJobs,
  organization,
  organizationApiKeys,
  transactions,
  user,
} from '@/platform/server/db/schema';
import {
  AttestationRequiredError,
  InsufficientCreditsError,
} from '@/platform/errors';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import { micros } from '@/billing/money';
import {
  GATEWAY_PLATFORM_FEE_BPS,
  gatewayCharge,
} from '@/gateway/charge-lines';
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
const requireCheckedUploadRights = vi.fn(
  async (
    _scopedDb: {
      apiKeys: { resolveLlmKey: (model: string) => Promise<unknown> };
    },
    _urls: string[],
    _request: unknown
  ) => new Map()
);
const likenessFromLedger = vi.fn(async () => 'none' as const);

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/cast/server/upload-check', () => ({ requireCheckedUploadRights }));
vi.doMock('@/cast/server/upload-rights', () => ({ likenessFromLedger }));
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
const { readGatewayJob } = await import('./read-job');
const { settleGatewayJob } = await import('./settle');
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { toWorkflowScopedDb } =
  await import('@/platform/server/db/scoped-workflow');

const organizationId = generateId();
const otherOrganizationId = generateId();
const brokeOrganizationId = generateId();
const userId = generateId();
const request = { ipAddress: '203.0.113.9', userAgent: 'vitest' };

const IMAGE = gatewayJobRequestSchema.parse({
  kind: 'image',
  model: 'gpt_image_2',
  prompt: 'a fox',
  referenceImageUrls: ['https://example.com/ref.png'],
});

function ctx(
  scopedDb: ReturnType<typeof createScopedDb>,
  idempotencyKey: string | null = null,
  oauthClientId: string | null = null
) {
  return { scopedDb, request, idempotencyKey, oauthClientId };
}

function lastPayload(): GatewayGenerationWorkflowInput {
  const payload = triggerWorkflow.mock.lastCall?.[1];
  if (!payload) throw new Error('no run was triggered');
  return payload;
}

const OUTPUT = { url: '/r2/a.png', path: 'a.png', contentType: 'image/png' };

async function reservationsFor(orgId: string) {
  return db
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.organizationId, orgId));
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db.insert(organization).values([
    { id: organizationId, name: 'T', slug: 't' },
    { id: otherOrganizationId, name: 'O', slug: 'o' },
    { id: brokeOrganizationId, name: 'B', slug: 'b' },
  ]);
  await db.insert(credits).values([
    { organizationId, balance: 100_000_000 },
    { organizationId: otherOrganizationId, balance: 100_000_000 },
    { organizationId: brokeOrganizationId, balance: 0 },
  ]);
  // The organization brings its own fal key; the gateway must still bill it.
  await db.insert(organizationApiKeys).values({
    organizationId,
    provider: 'fal',
    encryptedKey: 'x',
    keyIv: 'x',
    keyTag: 'x',
    keyHint: 'x',
    addedBy: userId,
  });
  // The user-pays submits below spend under this grant.
  await db.insert(gatewayGrants).values({
    oauthClientId: 'client-1',
    userId,
    organizationId,
    monthlyCapMicros: 1_000_000_000,
  });
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitGatewayJob', () => {
  it('holds the estimate and triggers one run, even with an own key on file', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    expect(await scopedDb.apiKeys.hasUsableKey('fal')).toBe(true);

    const { job, replay } = await submitGatewayJob(IMAGE, ctx(scopedDb));
    expect(replay).toBe(false);
    expect(job).toMatchObject({
      status: 'queued',
      kind: 'image',
      modelKey: 'gpt_image_2',
      workflowRunId: 'run-1',
    });
    expect(job.reservationId).toEqual(expect.any(String));

    const [hold] = (await reservationsFor(organizationId)).filter(
      (row) => row.id === job.reservationId
    );
    expect(hold?.remainingAmount).toBeGreaterThan(0);

    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/gateway',
      expect.objectContaining({
        jobId: job.id,
        organizationId,
        userId,
        reservationId: job.reservationId,
        ownsReservation: true,
        input: {
          kind: 'image',
          model: 'gpt_image_2',
          prompt: 'a fox',
          aspectRatio: '16:9',
          referenceImageUrls: ['https://example.com/ref.png'],
        },
      }),
      { deduplicationId: `gateway-${job.id}` }
    );
  });

  it('checks every reference URL before anything spends', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const video = gatewayJobRequestSchema.parse({
      kind: 'video',
      model: 'seedance_v2',
      prompt: 'the fox runs',
      startImageUrl: '/r2/talent/x/start.png',
      duration: 7.4,
    });
    const before = (await reservationsFor(organizationId)).length;
    requireCheckedUploadRights.mockRejectedValueOnce(
      new AttestationRequiredError('needs a portrait attestation')
    );
    await expect(submitGatewayJob(video, ctx(scopedDb))).rejects.toBeInstanceOf(
      AttestationRequiredError
    );
    expect(requireCheckedUploadRights).toHaveBeenCalledWith(
      expect.anything(),
      ['/r2/talent/x/start.png'],
      request
    );
    expect(triggerWorkflow).not.toHaveBeenCalled();
    expect((await reservationsFor(organizationId)).length).toBe(before);

    // Cleared: the run gets the snapped length and the no-person verdict.
    const { job } = await submitGatewayJob(video, ctx(scopedDb));
    expect(job.input).toMatchObject({ kind: 'video', duration: 7 });
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/gateway',
      expect.objectContaining({ noPersonImages: ['/r2/talent/x/start.png'] }),
      expect.anything()
    );
  });

  it('runs the likeness check on the platform LLM key, never the organization key', async () => {
    vi.stubEnv('OPENROUTER_KEY', 'platform-openrouter');
    try {
      const scopedDb = createScopedDb(organizationId, userId);
      scopedDb.apiKeys.resolveLlmKey = async () => {
        throw new Error('organization LLM key resolved');
      };
      await submitGatewayJob(IMAGE, ctx(scopedDb));
      const checked = requireCheckedUploadRights.mock.calls[0]?.[0];
      expect(await checked?.apiKeys.resolveLlmKey('openai/gpt-5')).toEqual({
        key: 'platform-openrouter',
        via: 'openrouter',
        source: 'platform',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('replays an Idempotency-Key as the job it first made', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const first = await submitGatewayJob(IMAGE, ctx(scopedDb, 'retry-1'));
    const holdsAfterFirst = (await reservationsFor(organizationId)).length;
    const again = await submitGatewayJob(IMAGE, ctx(scopedDb, 'retry-1'));
    expect(again).toEqual({ job: first.job, replay: true });
    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
    expect((await reservationsFor(organizationId)).length).toBe(
      holdsAfterFirst
    );
  });

  it('refuses for credits with a 402 and leaves no job behind', async () => {
    const scopedDb = createScopedDb(brokeOrganizationId, userId);
    const error = await submitGatewayJob(IMAGE, ctx(scopedDb, 'broke-1')).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(InsufficientCreditsError);
    const response = await runApiV1Handler(async () => {
      throw error;
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error: { code: 'INSUFFICIENT_CREDITS' },
    });
    expect(triggerWorkflow).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(gatewayJobs)
      .where(eq(gatewayJobs.organizationId, brokeOrganizationId));
    expect(rows).toEqual([]);

    // Topped up, the same key now runs.
    await db
      .update(credits)
      .set({ balance: 100_000_000 })
      .where(eq(credits.organizationId, brokeOrganizationId));
    const { replay } = await submitGatewayJob(IMAGE, ctx(scopedDb, 'broke-1'));
    expect(replay).toBe(false);
  });

  it('marks the job failed and releases the hold when the trigger fails', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const zeroedBefore = (await reservationsFor(organizationId)).filter(
      (row) => row.remainingAmount === 0
    ).length;
    triggerWorkflow.mockRejectedValueOnce(new Error('binding down'));
    await expect(
      submitGatewayJob(IMAGE, ctx(scopedDb, 'trigger-fails'))
    ).rejects.toThrow('binding down');
    const [job] = await db
      .select()
      .from(gatewayJobs)
      .where(
        and(
          eq(gatewayJobs.organizationId, organizationId),
          eq(gatewayJobs.idempotencyKey, 'trigger-fails')
        )
      );
    expect(job).toMatchObject({
      status: 'failed',
      error: { code: 'NOT_STARTED' },
    });
    const zeroedAfter = (await reservationsFor(organizationId)).filter(
      (row) => row.remainingAmount === 0
    ).length;
    expect(zeroedAfter).toBe(zeroedBefore + 1);
  });
});

describe('readGatewayJob', () => {
  it("is a 404 for another organization's job", async () => {
    const own = createScopedDb(organizationId, userId);
    const other = createScopedDb(otherOrganizationId, userId);
    const { job } = await submitGatewayJob(IMAGE, ctx(own));

    const document = await readGatewayJob(own, job.id, {
      origin: 'https://openstory.test',
      waitMs: 0,
    });
    expect(document).toMatchObject({ id: job.id, status: 'queued' });
    expect(document._links.self?.href).toBe(`/api/v1/gateway/jobs/${job.id}`);

    const response = await runApiV1Handler(async () =>
      Response.json(
        await readGatewayJob(other, job.id, {
          origin: 'https://openstory.test',
          waitMs: 0,
        })
      )
    );
    expect(response.status).toBe(404);
  });
});

describe('the charge', () => {
  const origin = 'https://openstory.test';

  /** What the run does at its end, against the real tables. */
  async function finishRun(
    scopedDb: ReturnType<typeof createScopedDb>,
    payload: GatewayGenerationWorkflowInput,
    costMicros: number
  ) {
    const run = toWorkflowScopedDb(scopedDb);
    await run.gatewayJobs.markRunning(payload.jobId);
    await run.gatewayJobs.recordOutputs(payload.jobId, {
      outputs: [OUTPUT],
      via: 'fal',
    });
    return settleGatewayJob({
      scopedDb: run,
      jobId: payload.jobId,
      model: 'gpt_image_2',
      reservationId: payload.reservationId,
      costMicros: micros(costMicros),
      estimateMicros: payload.estimateMicros,
      platformFeeBps: payload.platformFeeBps,
      oauthClientId: payload.oauthClientId,
      usedOwnKey: false,
      idempotencyKey: `${payload.jobId}:gateway-settle`,
      result: { outputs: [OUTPUT], via: 'fal' },
    });
  }

  it('holds every line of the charge on the estimate, at the fee snapshotted on the payload', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(
      IMAGE,
      ctx(scopedDb, null, 'client-1')
    );
    const payload = lastPayload();
    expect(payload.platformFeeBps).toBe(GATEWAY_PLATFORM_FEE_BPS);
    expect(payload.oauthClientId).toBe('client-1');
    expect(payload.estimateMicros).toBeGreaterThan(0);
    const [hold] = (await reservationsFor(organizationId)).filter(
      (row) => row.id === job.reservationId
    );
    expect(hold?.originalAmount).toBe(
      gatewayCharge({
        providerCostMicros: payload.estimateMicros,
        platformFeeBps: payload.platformFeeBps,
      }).totalMicros
    );
  });

  it('settles into lines the job document shows, summing to the debit', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(
      IMAGE,
      ctx(scopedDb, null, 'client-1')
    );
    const payload = lastPayload();
    const charged = await finishRun(scopedDb, payload, 12_345);
    expect(charged).toBe(12_345);

    const document = await readGatewayJob(scopedDb, job.id, {
      origin,
      waitMs: 0,
    });
    expect(document).toMatchObject({
      status: 'succeeded',
      outputs: [{ url: `${origin}/r2/a.png`, contentType: 'image/png' }],
      charge: {
        totalMicros: 12_345,
        lines: [{ kind: 'provider_cost', amountMicros: 12_345 }],
      },
    });
    const lines = await db
      .select()
      .from(chargeLines)
      .where(eq(chargeLines.gatewayJobId, job.id));
    expect(lines).toEqual([
      expect.objectContaining({
        organizationId,
        payeeOrganizationId: null,
        oauthClientId: 'client-1',
        amountMicros: 12_345,
      }),
    ]);
    const [debit] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, lines[0]?.transactionId ?? ''));
    expect(debit?.amount).toBe(-12_345);

    // Another organization sees no lines of a job it did not pay for.
    const other = createScopedDb(otherOrganizationId, userId);
    expect(await other.gatewayJobs.getChargeLines(job.id)).toEqual([]);
  });

  it('a charged job whose success write never landed ends succeeded, not failed', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(IMAGE, ctx(scopedDb));
    const payload = lastPayload();
    // The settle's debit and lines land; the run then dies before markSucceeded.
    await scopedDb.gatewayJobs.markRunning(job.id);
    await scopedDb.gatewayJobs.recordOutputs(job.id, {
      outputs: [OUTPUT],
      via: 'fal',
    });
    await scopedDb.billing.settleReservation(
      payload.reservationId ?? '',
      gatewayCharge({
        providerCostMicros: micros(9_000),
        platformFeeBps: 0,
      }).lines,
      {
        idempotencyKey: 'dies:gateway-settle',
        attribution: { gatewayJobId: job.id },
      }
    );
    await scopedDb.gatewayJobs.markFailed(job.id, {
      code: 'GENERATION_FAILED',
      message: 'persist failed',
    });

    expect(await scopedDb.gatewayJobs.getById(job.id)).toMatchObject({
      status: 'succeeded',
      error: null,
      costMicros: 9_000,
      outputs: [OUTPUT],
    });
  });

  it('an uncharged job still fails', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(IMAGE, ctx(scopedDb));
    await scopedDb.gatewayJobs.markRunning(job.id);
    await scopedDb.gatewayJobs.recordOutputs(job.id, {
      outputs: [OUTPUT],
      via: 'fal',
    });
    await scopedDb.gatewayJobs.markFailed(job.id, {
      code: 'GENERATION_FAILED',
      message: 'boom',
    });
    expect(await scopedDb.gatewayJobs.getById(job.id)).toMatchObject({
      status: 'failed',
      error: { code: 'GENERATION_FAILED' },
    });
  });

  it('a run that started although its trigger threw lands as succeeded, charged, with its outputs', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    triggerWorkflow.mockRejectedValueOnce(new Error('lost reply'));
    await expect(
      submitGatewayJob(IMAGE, ctx(scopedDb, 'trigger-lost'))
    ).rejects.toThrow('lost reply');
    const payload = lastPayload();
    expect((await scopedDb.gatewayJobs.getById(payload.jobId))?.status).toBe(
      'failed'
    );

    // The instance was created after all and runs to the end.
    const charged = await finishRun(scopedDb, payload, 7_000);
    expect(charged).toBe(7_000);

    const replay = await submitGatewayJob(IMAGE, ctx(scopedDb, 'trigger-lost'));
    expect(replay.replay).toBe(true);
    const document = await readGatewayJob(scopedDb, payload.jobId, {
      origin,
      waitMs: 0,
    });
    expect(document).toMatchObject({
      status: 'succeeded',
      error: null,
      outputs: [{ url: `${origin}/r2/a.png` }],
      charge: {
        totalMicros: 7_000,
        lines: [{ kind: 'provider_cost', amountMicros: 7_000 }],
      },
    });
  });

  it('a real failure after a lost trigger replaces NOT_STARTED with its own error', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    triggerWorkflow.mockRejectedValueOnce(new Error('lost reply'));
    await expect(submitGatewayJob(IMAGE, ctx(scopedDb))).rejects.toThrow(
      'lost reply'
    );
    const { jobId } = lastPayload();
    await scopedDb.gatewayJobs.markRunning(jobId);
    expect((await scopedDb.gatewayJobs.getById(jobId))?.status).toBe('running');
    await scopedDb.gatewayJobs.markFailed(jobId, {
      code: 'CONTENT_REJECTED',
      message: 'flagged',
    });
    expect((await scopedDb.gatewayJobs.getById(jobId))?.error).toEqual({
      code: 'CONTENT_REJECTED',
      message: 'flagged',
    });
  });
});
