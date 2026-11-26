/**
 * The billing handover on the real migrations: a generation through the
 * `openstory` adapter is held and charged by the gateway exactly once, a
 * retried step reuses its job and hold, a failed job lets its hold go, and a
 * trusted caller's inline media is not refused.
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
import { NonRetryableError } from 'cloudflare:workflows';
import {
  generateAudio,
  generateImage,
  generateVideo,
  getVideoJobStatus,
} from '@tanstack/ai';
import { createTestDb } from '@/platform/server/db/test-d1';
import { generateId } from '@/platform/id';
import type { Database } from '@/platform/server/db/client';
import {
  chargeLines,
  creditReservations,
  credits,
  gatewayJobs,
  organization,
  transactions,
  user,
} from '@/platform/server/db/schema';
import type { GatewayModel } from '@/gateway/server/catalog';
import type { GatewayJobInput } from '@/gateway/schema';
import type { GatewayPoll, GatewayStart } from '@/gateway/server/providers';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import { micros } from '@/billing/money';

let db: Database;
let closeDb: () => Promise<void>;

const start = vi.fn<(...args: unknown[]) => Promise<GatewayStart>>();
const poll = vi.fn<(...args: unknown[]) => Promise<GatewayPoll>>();
vi.doMock('#db-client', () => ({ getDb: () => db }));
const env: Record<string, string | undefined> = {
  XAI_API_KEY: 'platform-xai',
  E2E_TEST: undefined,
};
vi.doMock('#env', () => ({ getEnv: () => env }));
vi.doMock('@/gateway/server/providers', () => ({
  GATEWAY_DRIVERS: {
    grok: {
      configured: () => true,
      // Grok's own rule: an image answers at once, a video queues.
      answersAtOnce: (endpointId: string) =>
        endpointId.startsWith('v1/images/'),
      start,
      poll,
    },
  },
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));

const { inProcessGateway, inProcessPoller, releaseInProcessJob } =
  await import('./in-process');
const {
  doneVideoJob,
  openstoryAudio,
  openstoryImage,
  openstoryVideo,
  openstoryVideoStatus,
} = await import('./index');
const submitJob = await import('../submit-job');
const { createScopedDb } = await import('@/platform/server/db/scoped');
const { toWorkflowScopedDb } =
  await import('@/platform/server/db/scoped-workflow');

const SOURCE = {
  url: 'https://docs.example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-01T00:00:00.000Z',
};
// $0.02 an image.
const FLAT = rateCardSchema.parse({
  inputs: {},
  tables: {},
  price: 0.02,
  examples: [],
  source: SOURCE,
});
const SCHEMA = {
  type: 'object',
  properties: { model: { type: 'string' }, prompt: { type: 'string' } },
  required: ['prompt'],
};
const IMAGE: GatewayModel = {
  provider: 'grok',
  id: 'grok-imagine-image',
  name: 'Grok Imagine',
  kind: 'image',
  endpointId: 'v1/images/generations',
  card: FLAT,
  inputSchema: SCHEMA,
};
const VIDEO: GatewayModel = {
  ...IMAGE,
  id: 'grok-imagine-video',
  kind: 'video',
  endpointId: 'v1/videos/generations',
};
const BODY = { prompt: 'Mara wipes her hands on a rag in the engine room' };

const START_BALANCE = 100_000_000;
const organizationId = generateId();
const userId = generateId();
const store = vi.fn(async (_media: unknown, index: number) => ({
  url: `/r2/out-${index}.png`,
  path: `out-${index}.png`,
  contentType: 'image/png',
}));

const workflowDb = () =>
  toWorkflowScopedDb(createScopedDb(organizationId, userId));

function transport(
  model: GatewayModel,
  reservationId: string | null = null,
  wireBody: (body: GatewayJobInput) => Promise<GatewayJobInput> = async (
    body
  ) => body
) {
  return inProcessGateway({
    scopedDb: workflowDb(),
    model,
    runId: 'image_run-1',
    store,
    uploadRightsChecked: submitJob.UPLOAD_RIGHTS_CHECKED,
    reservation: reservationId ? { id: reservationId } : null,
    wireBody,
  });
}

/** What a poll step builds: no model, key or rights. */
const statusAdapter = (model: GatewayModel) =>
  openstoryVideoStatus(
    model.id,
    inProcessPoller({ scopedDb: workflowDb(), store })
  );

/** Debits written for the job, and what its lines sum to. */
async function chargesFor(jobId: string) {
  const lines = await db
    .select()
    .from(chargeLines)
    .where(eq(chargeLines.gatewayJobId, jobId));
  const debits = new Set(lines.map((line) => line.transactionId));
  const usage = await db
    .select()
    .from(transactions)
    .where(eq(transactions.organizationId, organizationId));
  const [wallet] = await db
    .select()
    .from(credits)
    .where(eq(credits.organizationId, organizationId));
  return {
    debits: debits.size,
    linesMicros: lines.reduce((sum, line) => sum + line.amountMicros, 0),
    usageRows: usage.filter((row) => debits.has(row.id)).length,
    // A stray debit outside the settle shows here.
    balanceDrop: START_BALANCE - (wallet?.balance ?? 0),
  };
}

async function holdLeft(jobId: string) {
  const [hold] = await db
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.idempotencyKey, `gateway:${jobId}`));
  return hold?.remainingAmount;
}

async function onlyJob(modelKey: string) {
  const rows = await db
    .select()
    .from(gatewayJobs)
    .where(eq(gatewayJobs.modelKey, modelKey));
  expect(rows).toHaveLength(1);
  const [job] = rows;
  if (!job) throw new Error('no job');
  return job;
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
  await db
    .insert(organization)
    .values({ id: organizationId, name: 'T', slug: 't' });
  await db.insert(credits).values({ organizationId, balance: START_BALANCE });
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  vi.clearAllMocks();
  env.GATEWAY_PLATFORM_FEE_BPS = undefined;
  await db.delete(chargeLines);
  await db.delete(gatewayJobs);
  await db
    .update(credits)
    .set({ balance: START_BALANCE })
    .where(eq(credits.organizationId, organizationId));
});

const answered: GatewayStart = {
  result: {
    media: [{ url: 'https://imgen.x.ai/a.png', contentType: null }],
    usage: null,
    requestId: null,
  },
};

describe('the openstory adapter, in-process', () => {
  it('replays a retried step whose references were uploaded again: no second call, the stored outputs', async () => {
    const withRefs: GatewayModel = {
      ...IMAGE,
      id: 'grok-image-refs',
      inputSchema: {
        ...SCHEMA,
        properties: {
          ...SCHEMA.properties,
          image_urls: { type: 'array', items: { type: 'string' } },
        },
      },
    };
    const held = { ...BODY, image_urls: ['/r2/uploads/a.png'] };
    let upload = 0;
    // Each attempt's upload is a new URL, as fal storage gives without a CDN.
    const wireBody = vi.fn(async (body: GatewayJobInput) => ({
      ...body,
      image_urls: [`https://fal.media/files/${++upload}.png`],
    }));
    start.mockResolvedValue(answered);
    const attempt = () =>
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(
          withRefs.id,
          transport(withRefs, null, wireBody),
          { idempotencyKey: 'run-9:image' }
        ),
        prompt: '',
        modelOptions: held,
      });
    await attempt();
    const replay = await attempt();

    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      image_urls: ['https://fal.media/files/1.png'],
    });
    expect(replay.images).toEqual([{ url: '/r2/out-0.png' }]);
    const job = await onlyJob(withRefs.id);
    expect(job.input).toMatchObject({ image_urls: ['/r2/uploads/a.png'] });
    expect(await chargesFor(job.id)).toMatchObject({ debits: 1 });
  });

  it('wireBody failing leaves nothing held; the retry holds and starts the job once', async () => {
    const wireBody = vi
      .fn<(body: GatewayJobInput) => Promise<GatewayJobInput>>()
      .mockRejectedValueOnce(new Error('fal storage is down'))
      .mockImplementation(async (body) => body);
    start.mockResolvedValue(answered);
    const attempt = () =>
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE, null, wireBody), {
          idempotencyKey: 'run-11:image',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    await expect(attempt()).rejects.toThrow('fal storage is down');
    // No job, so no hold (`gateway:<job>`) and nothing for the sweep.
    expect(
      await db
        .select()
        .from(gatewayJobs)
        .where(eq(gatewayJobs.modelKey, IMAGE.id))
    ).toEqual([]);

    await attempt();
    expect(start).toHaveBeenCalledTimes(1);
    const job = await onlyJob(IMAGE.id);
    expect(await chargesFor(job.id)).toMatchObject({ debits: 1 });
  });

  it('replays a retried video submit whose references were uploaded again: one provider start', async () => {
    const withRefs: GatewayModel = {
      ...VIDEO,
      id: 'grok-video-refs',
      inputSchema: {
        ...SCHEMA,
        properties: {
          ...SCHEMA.properties,
          image_urls: { type: 'array', items: { type: 'string' } },
        },
      },
    };
    let upload = 0;
    const wireBody = vi.fn(async (body: GatewayJobInput) => ({
      ...body,
      image_urls: [`https://fal.media/files/${++upload}.png`],
    }));
    start.mockResolvedValue({ jobId: 'provider-video-1' });
    const submit = () =>
      generateVideo({
        threadId: 'thread-1',
        adapter: openstoryVideo(
          withRefs.id,
          transport(withRefs, null, wireBody),
          { idempotencyKey: 'run-10:submit' }
        ),
        prompt: '',
        modelOptions: { ...BODY, image_urls: ['/r2/talent/org/sheets/a.png'] },
      });
    const first = await submit();
    const retried = await submit();

    expect(retried.jobId).toBe(first.jobId);
    expect(start).toHaveBeenCalledTimes(1);
    const job = await onlyJob(withRefs.id);
    expect(job.input).toMatchObject({
      image_urls: ['/r2/talent/org/sheets/a.png'],
    });
  });

  it('charges one image exactly once, at the card price', async () => {
    start.mockResolvedValue(answered);
    const result = await generateImage({
      threadId: 'thread-1',
      adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
        idempotencyKey: 'run-1:image',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    expect(result.images).toEqual([{ url: '/r2/out-0.png' }]);
    // Stored by the caller's store, inside the call that received it.
    expect(store).toHaveBeenCalledTimes(1);

    const job = await onlyJob(IMAGE.id);
    expect(job.status).toBe('succeeded');
    expect(job.workflowRunId).toBe('image_run-1');
    // Zero times fails here; twice fails below.
    expect(await chargesFor(job.id)).toEqual({
      debits: 1,
      linesMicros: 20_000,
      usageRows: 1,
      balanceDrop: 20_000,
    });
    // What the charge did not capture goes back at once, not at the hold's TTL.
    expect(await holdLeft(job.id)).toBe(0);
  });

  it.each([
    [undefined, 20_000, []],
    ['250', 20_500, [{ kind: 'platform_fee', amountMicros: 500 }]],
  ])(
    'at fee %s bps the hold, the quote and the debit are the estimate plus the fee',
    async (fee, total, feeLines) => {
      env.GATEWAY_PLATFORM_FEE_BPS = fee;
      start.mockResolvedValue(answered);
      await generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
          idempotencyKey: `run-fee-${fee}:image`,
        }),
        prompt: '',
        modelOptions: BODY,
      });
      const job = await onlyJob(IMAGE.id);
      const [hold] = await db
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.idempotencyKey, `gateway:${job.id}`));
      expect(hold?.originalAmount).toBe(total);
      expect(submitJob.gatewayHoldMicros(micros(20_000))).toBe(total);
      const lines = await db
        .select({
          kind: chargeLines.kind,
          amountMicros: chargeLines.amountMicros,
        })
        .from(chargeLines)
        .where(eq(chargeLines.gatewayJobId, job.id));
      expect(lines).toEqual(
        expect.arrayContaining([
          { kind: 'provider_cost', amountMicros: 20_000 },
          ...feeLines,
        ])
      );
      expect(lines).toHaveLength(1 + feeLines.length);
      expect(await chargesFor(job.id)).toEqual({
        debits: 1,
        linesMicros: total,
        usageRows: 1,
        balanceDrop: total,
      });
    }
  );

  it('gives back what a usage-priced job did not spend once it is charged', async () => {
    // Held at the 120 second estimate ($0.30), billed for 8 seconds ($0.02).
    const card = rateCardSchema.parse({
      inputs: {
        original_duration: {
          param: 'original_duration',
          bound: 'usage',
          kind: 'number',
          estimate: { inputs: {}, value: 120, source: SOURCE },
        },
      },
      tables: {},
      price: { '*': [{ var: 'original_duration' }, 0.0025] },
      examples: [],
      source: SOURCE,
    });
    start.mockResolvedValueOnce({
      result: { ...answered.result, usage: { original_duration: 8 } },
    });
    const usageImage = { ...IMAGE, id: 'grok-usage-image', card };
    await generateImage({
      threadId: 'thread-1',
      adapter: openstoryImage(usageImage.id, transport(usageImage), {
        idempotencyKey: 'run-7:image',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    const job = await onlyJob(usageImage.id);
    expect(await chargesFor(job.id)).toMatchObject({ balanceDrop: 20_000 });
    expect(await holdLeft(job.id)).toBe(0);
  });

  it('sends an answering model again under the same key after a 5xx, which ran nothing, and charges once', async () => {
    start
      .mockRejectedValueOnce(
        Object.assign(new Error('Provider refused the request (500): busy'), {
          statusCode: 500,
        })
      )
      .mockResolvedValueOnce(answered);
    const submit = () =>
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
          idempotencyKey: 'run-5:image',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    const error = await submit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    const job = await onlyJob(IMAGE.id);
    expect(job.status).toBe('queued');
    expect(await holdLeft(job.id)).toBe(20_000);
    await submit();
    expect(start).toHaveBeenCalledTimes(2);
    expect((await onlyJob(IMAGE.id)).status).toBe('succeeded');
    expect(await chargesFor(job.id)).toMatchObject({
      debits: 1,
      balanceDrop: 20_000,
    });
  });

  it.each([502, 504, 520, 524])(
    'never sends an answering model again after a proxy %i, which may follow a billed request',
    async (statusCode) => {
      start.mockRejectedValueOnce(
        Object.assign(
          new Error(`Provider refused the request (${statusCode})`),
          {
            statusCode,
          }
        )
      );
      const submit = () =>
        generateImage({
          threadId: 'thread-1',
          adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
            idempotencyKey: `run-9-${statusCode}:image`,
          }),
          prompt: '',
          modelOptions: BODY,
        });
      const first = await submit().catch((e: unknown) => e);
      expect(first).not.toBeInstanceOf(NonRetryableError);
      expect((await onlyJob(IMAGE.id)).status).toBe('running');
      // The retried step fails closed and lets the hold go.
      await expect(submit()).rejects.toBeInstanceOf(NonRetryableError);
      expect(start).toHaveBeenCalledTimes(1);
      const job = await onlyJob(IMAGE.id);
      expect(job.status).toBe('failed');
      expect(await holdLeft(job.id)).toBe(0);
    }
  );

  it('fails a queued submit at once on a 5xx, which may have queued it, and lets the hold go', async () => {
    start.mockRejectedValueOnce(
      Object.assign(new Error('Provider refused the request (500): busy'), {
        statusCode: 500,
      })
    );
    const submit = () =>
      generateVideo({
        threadId: 'thread-1',
        adapter: openstoryVideo(VIDEO.id, transport(VIDEO), {
          idempotencyKey: 'run-5:video',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    await expect(submit()).rejects.toBeInstanceOf(NonRetryableError);
    const job = await onlyJob(VIDEO.id);
    expect(job.status).toBe('failed');
    expect(await holdLeft(job.id)).toBe(0);
    // A retried step reads the failed job and never sends it again.
    await expect(submit()).rejects.toBeInstanceOf(NonRetryableError);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps the hold on a start that may have reached the provider', async () => {
    start.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
          idempotencyKey: 'run-6:image',
        }),
        prompt: '',
        modelOptions: BODY,
      })
    ).rejects.not.toBeInstanceOf(NonRetryableError);
    const job = await onlyJob(IMAGE.id);
    expect(job.status).toBe('running');
    expect(await holdLeft(job.id)).toBeGreaterThan(0);
  });

  it('gives back the rest of the hold on a replay when the settle step died before its zero', async () => {
    start.mockResolvedValue(answered);
    const submit = () =>
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
          idempotencyKey: 'run-8:image',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    await submit();
    const job = await onlyJob(IMAGE.id);
    // As if the zero after the charge had thrown.
    await db
      .update(creditReservations)
      .set({ remainingAmount: 5_000 })
      .where(eq(creditReservations.idempotencyKey, `gateway:${job.id}`));
    await submit();
    expect(start).toHaveBeenCalledTimes(1);
    expect(await holdLeft(job.id)).toBe(0);
  });

  it('never charges twice when the step is retried', async () => {
    start.mockResolvedValue(answered);
    for (let attempt = 0; attempt < 2; attempt++) {
      await generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
          idempotencyKey: 'run-2:image',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    }
    // The provider ran once: the retry got the stored outputs back.
    expect(start).toHaveBeenCalledTimes(1);
    const job = await onlyJob(IMAGE.id);
    expect(await chargesFor(job.id)).toEqual({
      debits: 1,
      linesMicros: 20_000,
      usageRows: 1,
      balanceDrop: 20_000,
    });
    const holds = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `gateway:${job.id}`));
    expect(holds).toHaveLength(1);
  });

  it('polls a video job across steps and charges it once', async () => {
    start.mockResolvedValue({ jobId: 'xai-1' });
    poll.mockResolvedValueOnce({ status: 'pending' }).mockResolvedValue({
      status: 'done',
      result: {
        media: [{ url: 'https://vidgen.x.ai/a.mp4', contentType: 'video/mp4' }],
        usage: null,
        requestId: 'xai-1',
      },
    });
    // Each step builds its own adapter; the job id carries what a poll needs.
    const { jobId } = await generateVideo({
      threadId: 'thread-1',
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO), {
        idempotencyKey: 'run-3:submit',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    const pollStep = () =>
      getVideoJobStatus({
        adapter: statusAdapter(VIDEO),
        jobId,
      });
    expect((await pollStep()).status).toBe('processing');
    expect(await pollStep()).toMatchObject({
      status: 'completed',
      url: '/r2/out-0.png',
    });
    // A poll retried after the charge answers from the row: same URL, no second store.
    expect(await pollStep()).toMatchObject({
      status: 'completed',
      url: '/r2/out-0.png',
    });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(store).toHaveBeenCalledTimes(1);
    const job = await onlyJob(VIDEO.id);
    expect(job).toMatchObject({ status: 'succeeded', providerJobId: 'xai-1' });
    // A submit replayed after the job finished answers `done:`, still naming the job so its charge can be read.
    const replayed = await generateVideo({
      threadId: 'thread-1',
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO), {
        idempotencyKey: 'run-3:submit',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    expect(doneVideoJob(replayed.jobId)?.jobId).toBe(job.id);
    expect(start).toHaveBeenCalledOnce();
    expect(await chargesFor(job.id)).toEqual({
      debits: 1,
      linesMicros: 20_000,
      usageRows: 1,
      balanceDrop: 20_000,
    });
  });

  it('resumes a replayed submit on its stored provider job, never starting it twice', async () => {
    start.mockResolvedValue({ jobId: 'xai-9' });
    poll.mockResolvedValue({
      status: 'done',
      result: {
        media: [{ url: 'https://vidgen.x.ai/a.mp4', contentType: 'video/mp4' }],
        usage: null,
        requestId: 'xai-9',
      },
    });
    const submitStep = () =>
      generateVideo({
        threadId: 'thread-1',
        adapter: openstoryVideo(VIDEO.id, transport(VIDEO), {
          idempotencyKey: 'run-9:submit',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    const first = await submitStep();
    // The submit step is retried after the provider took the job.
    const replayed = await submitStep();
    expect(start).toHaveBeenCalledTimes(1);
    await getVideoJobStatus({
      adapter: statusAdapter(VIDEO),
      jobId: replayed.jobId,
    });
    expect(replayed.jobId).toBe(first.jobId);
    const job = await onlyJob(VIDEO.id);
    expect(await chargesFor(job.id)).toEqual({
      debits: 1,
      linesMicros: 20_000,
      usageRows: 1,
      balanceDrop: 20_000,
    });
  });

  it('fails rather than resend a job started but never stamped', async () => {
    start.mockResolvedValue({ jobId: 'xai-10' });
    const submitStep = () =>
      generateVideo({
        threadId: 'thread-1',
        adapter: openstoryVideo(VIDEO.id, transport(VIDEO), {
          idempotencyKey: 'run-10:submit',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    await submitStep();
    // As if the first attempt died between the provider's answer and the stamp.
    await db
      .update(gatewayJobs)
      .set({ providerJobId: null })
      .where(eq(gatewayJobs.modelKey, VIDEO.id));
    await expect(submitStep()).rejects.toThrow('may have started');
    expect(start).toHaveBeenCalledTimes(1);
    const job = await onlyJob(VIDEO.id);
    expect(job.status).toBe('failed');
    const [hold] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `gateway:${job.id}`));
    expect(hold?.remainingAmount).toBe(0);
  });

  it('recovers a retried submit on the same transport object', async () => {
    start.mockResolvedValue({ jobId: 'xai-11' });
    // A workflow retries `step.do` by calling the callback again: the transport is reused.
    const shared = transport(VIDEO);
    const submitStep = () =>
      generateVideo({
        threadId: 'thread-1',
        adapter: openstoryVideo(VIDEO.id, shared, {
          idempotencyKey: 'run-11:submit',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    const first = await submitStep();
    const retried = await submitStep();
    expect(retried.jobId).toBe(first.jobId);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('throws on a succeeded job with no outputs rather than answer with no media', async () => {
    start.mockResolvedValue(answered);
    const step = () =>
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
          idempotencyKey: 'run-12:image',
        }),
        prompt: '',
        modelOptions: BODY,
      });
    await step();
    await db
      .update(gatewayJobs)
      .set({ outputs: [] })
      .where(eq(gatewayJobs.modelKey, IMAGE.id));
    await expect(step()).rejects.toThrow('succeeded with no outputs');
  });

  it('lets the hold go when the provider fails the job', async () => {
    start.mockResolvedValue({ jobId: 'xai-2' });
    poll.mockResolvedValue({ status: 'failed', error: 'Job failed' });
    const { jobId } = await generateVideo({
      threadId: 'thread-1',
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO), {
        idempotencyKey: 'run-4:submit',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    const status = await getVideoJobStatus({
      adapter: statusAdapter(VIDEO),
      jobId,
    });
    expect(status).toMatchObject({ status: 'failed', error: 'Job failed' });
    const job = await onlyJob(VIDEO.id);
    expect(job.status).toBe('failed');
    expect(await chargesFor(job.id)).toMatchObject({ debits: 0 });
    const [hold] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `gateway:${job.id}`));
    expect(hold?.remainingAmount).toBe(0);
  });

  it('releases its own hold when the run gives up on a queued job', async () => {
    start.mockResolvedValue({ jobId: 'xai-6' });
    const { jobId } = await generateVideo({
      threadId: 'thread-1',
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO), {
        idempotencyKey: 'run-6:submit',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    await releaseInProcessJob(workflowDb(), jobId, 'timed out');
    const job = await onlyJob(VIDEO.id);
    expect(job.status).toBe('failed');
    const [hold] = await db
      .select()
      .from(creditReservations)
      .where(eq(creditReservations.idempotencyKey, `gateway:${job.id}`));
    expect(hold?.remainingAmount).toBe(0);
  });

  it('returns one stored audio file', async () => {
    start.mockResolvedValue({
      result: {
        media: [{ base64: 'AAAA', contentType: 'audio/wav' }],
        usage: null,
        requestId: null,
      },
    });
    const audio: GatewayModel = { ...IMAGE, id: 'grok-audio', kind: 'audio' };
    const result = await generateAudio({
      threadId: 'thread-1',
      adapter: openstoryAudio(audio.id, transport(audio), {
        idempotencyKey: 'run-7:audio',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    expect(result.audio).toEqual({
      url: '/r2/out-0.png',
      contentType: 'image/png',
    });
    expect(await chargesFor((await onlyJob(audio.id)).id)).toMatchObject({
      debits: 1,
    });
  });

  it('accepts inline media from a trusted caller', async () => {
    start.mockResolvedValue(answered);
    await generateImage({
      threadId: 'thread-1',
      adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
        idempotencyKey: 'run-5:image',
      }),
      prompt: '',
      modelOptions: { prompt: 'data:image/png;base64,AAAA' },
    });
    expect((await onlyJob(IMAGE.id)).status).toBe('succeeded');
  });

  it('refuses TanStack fields the gateway does not build a body from', async () => {
    await expect(
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE), {
          idempotencyKey: 'run-6:image',
        }),
        prompt: '',
        size: '1024x1024',
        modelOptions: BODY,
      })
    ).rejects.toThrow('Put size in the provider');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('on the caller run reservation (#2435)', () => {
  beforeEach(async () => {
    await db.delete(creditReservations);
  });

  async function runReservation(amount: number) {
    const held = await createScopedDb(
      organizationId,
      userId
    ).billing.createReservation(micros(amount), {
      idempotencyKey: `run:${generateId()}`,
    });
    if (!held.ok) throw new Error('no run reservation');
    return held.reservationId;
  }

  const remainingOf = async (id: string) =>
    (
      await db
        .select()
        .from(creditReservations)
        .where(eq(creditReservations.id, id))
    )[0]?.remainingAmount;

  const image = (reservationId: string | null, key: string) =>
    generateImage({
      threadId: 'thread-1',
      adapter: openstoryImage(IMAGE.id, transport(IMAGE, reservationId), {
        idempotencyKey: key,
      }),
      prompt: '',
      modelOptions: BODY,
    });

  it('holds nothing of its own and charges the run reservation once', async () => {
    start.mockResolvedValue(answered);
    const reservationId = await runReservation(30_000);
    await image(reservationId, 'run-r1:image');
    const job = await onlyJob(IMAGE.id);
    expect(await db.select().from(creditReservations)).toHaveLength(1);
    expect(await chargesFor(job.id)).toEqual({
      debits: 1,
      linesMicros: 20_000,
      usageRows: 1,
      balanceDrop: 20_000,
    });
    expect(await remainingOf(reservationId)).toBe(10_000);
  });

  it('runs when the balance covers the run reservation but not a second hold', async () => {
    start.mockResolvedValue(answered);
    await db
      .update(credits)
      .set({ balance: 30_000 })
      .where(eq(credits.organizationId, organizationId));
    const reservationId = await runReservation(30_000);
    await expect(image(null, 'run-r2:own')).rejects.toThrow(
      'Insufficient credits'
    );
    await db.delete(gatewayJobs);
    await image(reservationId, 'run-r2:image');
    const job = await onlyJob(IMAGE.id);
    expect(job.status).toBe('succeeded');
    expect(await remainingOf(reservationId)).toBe(10_000);
  });

  it('grows a borrowed reservation the charge outruns when the balance covers it', async () => {
    start.mockResolvedValue(answered);
    const reservationId = await runReservation(5_000);
    await image(reservationId, 'run-r6:image');
    const job = await onlyJob(IMAGE.id);
    expect(await chargesFor(job.id)).toEqual({
      debits: 1,
      linesMicros: 20_000,
      usageRows: 1,
      balanceDrop: 20_000,
    });
    expect(await remainingOf(reservationId)).toBe(0);
  });

  it('captures only what the balance holds past a borrowed reservation, lines summing to the debit', async () => {
    start.mockResolvedValue(answered);
    await db
      .update(credits)
      .set({ balance: 5_000 })
      .where(eq(credits.organizationId, organizationId));
    const reservationId = await runReservation(5_000);
    await image(reservationId, 'run-r7:image');
    const job = await onlyJob(IMAGE.id);
    expect(job.status).toBe('succeeded');
    const charged = await chargesFor(job.id);
    expect(charged).toMatchObject({ debits: 1, linesMicros: 5_000 });
    expect(job.costMicros).toBe(5_000);
    expect(await remainingOf(reservationId)).toBe(0);
  });

  it('reuses the job and charges once when the step is replayed', async () => {
    start.mockResolvedValue(answered);
    const reservationId = await runReservation(30_000);
    await image(reservationId, 'run-r3:image');
    await image(reservationId, 'run-r3:image');
    expect(start).toHaveBeenCalledTimes(1);
    const job = await onlyJob(IMAGE.id);
    expect(await chargesFor(job.id)).toMatchObject({ debits: 1 });
    expect(await remainingOf(reservationId)).toBe(10_000);
  });

  it('a run that gives up ends its job at once and keeps its reservation', async () => {
    start.mockResolvedValue({ jobId: 'xai-r5' });
    const reservationId = await runReservation(30_000);
    const { jobId } = await generateVideo({
      threadId: 'thread-1',
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO, reservationId), {
        idempotencyKey: 'run-r5:submit',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    await releaseInProcessJob(workflowDb(), jobId, 'timed out');
    expect((await onlyJob(VIDEO.id)).status).toBe('failed');
    expect(await remainingOf(reservationId)).toBe(30_000);
  });

  it('leaves the run reservation intact when the job fails', async () => {
    start.mockResolvedValue({ jobId: 'xai-r4' });
    poll.mockResolvedValue({ status: 'failed', error: 'Job failed' });
    const reservationId = await runReservation(30_000);
    const { jobId } = await generateVideo({
      threadId: 'thread-1',
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO, reservationId), {
        idempotencyKey: 'run-r4:submit',
      }),
      prompt: '',
      modelOptions: BODY,
    });
    await getVideoJobStatus({ adapter: statusAdapter(VIDEO), jobId });
    const job = await onlyJob(VIDEO.id);
    expect(job.status).toBe('failed');
    // Off the row, so the stale-job sweep cannot zero it either.
    expect(job.reservationId).toBeNull();
    expect(await chargesFor(job.id)).toMatchObject({ debits: 0 });
    expect(await remainingOf(reservationId)).toBe(30_000);
  });
});
