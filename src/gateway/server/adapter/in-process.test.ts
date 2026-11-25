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
import type { GatewayPoll, GatewayStart } from '@/gateway/server/providers';
import { rateCardSchema } from '@modelschemas/rate-card/schema';

let db: Database;
let closeDb: () => Promise<void>;

const start = vi.fn<(...args: unknown[]) => Promise<GatewayStart>>();
const poll = vi.fn<(...args: unknown[]) => Promise<GatewayPoll>>();
vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('#env', () => ({
  getEnv: () => ({ XAI_API_KEY: 'platform-xai', E2E_TEST: undefined }),
}));
vi.doMock('@/gateway/server/providers', () => ({
  GATEWAY_DRIVERS: {
    grok: { configured: () => true, start, poll },
  },
}));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));

const { inProcessGateway } = await import('./in-process');
const { openstoryAudio, openstoryImage, openstoryVideo } =
  await import('./index');
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

function transport(model: GatewayModel, idempotencyKey: string) {
  return inProcessGateway({
    scopedDb: toWorkflowScopedDb(createScopedDb(organizationId, userId)),
    model,
    runId: 'image_run-1',
    idempotencyKey,
    store,
    uploadRightsChecked: submitJob.UPLOAD_RIGHTS_CHECKED,
  });
}

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
  it('charges one image exactly once, at the card price', async () => {
    start.mockResolvedValue(answered);
    const result = await generateImage({
      threadId: 'thread-1',
      adapter: openstoryImage(IMAGE.id, transport(IMAGE, 'run-1:image')),
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
  });

  it('never charges twice when the step is retried', async () => {
    start.mockResolvedValue(answered);
    for (let attempt = 0; attempt < 2; attempt++) {
      await generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE, 'run-2:image')),
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
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO, 'run-3:submit')),
      prompt: '',
      modelOptions: BODY,
    });
    const pollStep = () =>
      getVideoJobStatus({
        adapter: openstoryVideo(VIDEO.id, transport(VIDEO, 'run-3:submit')),
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
        adapter: openstoryVideo(VIDEO.id, transport(VIDEO, 'run-9:submit')),
        prompt: '',
        modelOptions: BODY,
      });
    const first = await submitStep();
    // The submit step is retried after the provider took the job.
    const replayed = await submitStep();
    expect(start).toHaveBeenCalledTimes(1);
    await getVideoJobStatus({
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO, 'run-9:submit')),
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
        adapter: openstoryVideo(VIDEO.id, transport(VIDEO, 'run-10:submit')),
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

  it('refuses a second job on one transport', async () => {
    start.mockResolvedValue(answered);
    const adapter = openstoryImage(IMAGE.id, transport(IMAGE, 'run-11:image'));
    await generateImage({
      threadId: 'thread-1',
      adapter,
      prompt: '',
      modelOptions: BODY,
    });
    await expect(
      generateImage({
        threadId: 'thread-1',
        adapter,
        prompt: '',
        modelOptions: BODY,
      })
    ).rejects.toThrow('build one per call');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('lets the hold go when the provider fails the job', async () => {
    start.mockResolvedValue({ jobId: 'xai-2' });
    poll.mockResolvedValue({ status: 'failed', error: 'Job failed' });
    const { jobId } = await generateVideo({
      threadId: 'thread-1',
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO, 'run-4:submit')),
      prompt: '',
      modelOptions: BODY,
    });
    const status = await getVideoJobStatus({
      adapter: openstoryVideo(VIDEO.id, transport(VIDEO, 'run-4:submit')),
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
      adapter: openstoryAudio(audio.id, transport(audio, 'run-7:audio')),
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
      adapter: openstoryImage(IMAGE.id, transport(IMAGE, 'run-5:image')),
      prompt: '',
      modelOptions: { prompt: 'data:image/png;base64,AAAA' },
    });
    expect((await onlyJob(IMAGE.id)).status).toBe('succeeded');
  });

  it('refuses TanStack fields the gateway does not build a body from', async () => {
    await expect(
      generateImage({
        threadId: 'thread-1',
        adapter: openstoryImage(IMAGE.id, transport(IMAGE, 'run-6:image')),
        prompt: '',
        size: '1024x1024',
        modelOptions: BODY,
      })
    ).rejects.toThrow('Put size in the provider');
    expect(start).not.toHaveBeenCalled();
  });
});
