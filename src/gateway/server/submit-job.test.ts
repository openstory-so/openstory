/**
 * Submitting a gateway job on the real migrations: the schema and price
 * refusals, the hold, the trigger, a replayed `Idempotency-Key`, a refusal for
 * credits, the upload check before anything spends, platform keys only, and
 * another organization's job as a 404.
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
  creditReservations,
  credits,
  gatewayJobs,
  organization,
  organizationApiKeys,
  user,
} from '@/platform/server/db/schema';
import {
  AttestationRequiredError,
  InsufficientCreditsError,
  NotFoundError,
  ValidationError,
} from '@/platform/errors';
import { runApiV1Handler } from '@/platform/server/api-v1/errors';
import type { GatewayJobInput, GatewayProvider } from '@/gateway/schema';
import type { GatewayModel } from '@/gateway/server/catalog';
import { rateCardSchema } from '@modelschemas/rate-card/schema';

let db: Database;
let closeDb: () => Promise<void>;

const SOURCE = {
  url: 'https://docs.example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-01T00:00:00.000Z',
};

// $0.08 a second, read off the request.
const PER_SECOND = rateCardSchema.parse({
  inputs: { duration: { param: 'duration', bound: 'request', kind: 'number' } },
  tables: {},
  price: { '*': [{ var: 'duration' }, 0.08] },
  examples: [],
  source: SOURCE,
});

// Priced on a count only the provider knows, with no estimate.
const PER_TOKEN = rateCardSchema.parse({
  inputs: {
    output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
  },
  tables: {},
  price: { '*': [{ var: 'output_tokens' }, 0.00001] },
  examples: [],
  source: SOURCE,
});

const VIDEO_SCHEMA = {
  type: 'object',
  properties: {
    model: { type: 'string' },
    prompt: { type: 'string' },
    duration: { type: 'number' },
    image: { type: 'object' },
    content: { type: 'array' },
  },
  required: ['prompt', 'duration'],
};

const MODELS: Record<string, GatewayModel> = {
  'grok/grok-imagine-video': {
    provider: 'grok',
    id: 'grok-imagine-video',
    name: 'Grok Imagine Video',
    kind: 'video',
    endpointId: 'v1/videos/generations',
    card: PER_SECOND,
    inputSchema: VIDEO_SCHEMA,
  },
  // fal names the model in the path only: its schema has no `model`.
  'fal/fal-ai/ferry/video': {
    provider: 'fal',
    id: 'fal-ai/ferry/video',
    name: 'Ferry Video',
    kind: 'video',
    endpointId: 'fal-ai/ferry/video',
    card: PER_SECOND,
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, duration: { type: 'number' } },
      required: ['prompt'],
    },
  },
  // A grok schema that forgot `model` and names a count the card does not price.
  'grok/grok-imagine-loose': {
    provider: 'grok',
    id: 'grok-imagine-loose',
    name: 'Grok Imagine Loose',
    kind: 'video',
    endpointId: 'v1/videos/generations',
    card: PER_SECOND,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        duration: { type: 'number' },
        n: { type: 'number' },
      },
      required: ['prompt', 'duration'],
    },
  },
  'byteplus/seed-audio-1.0': {
    provider: 'byteplus',
    id: 'seed-audio-1.0',
    name: 'Seed Audio',
    kind: 'audio',
    endpointId: 'tts/create',
    card: PER_SECOND,
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string' },
        text_prompt: { type: 'string' },
        duration: { type: 'number' },
        references: { type: 'array' },
      },
      required: ['text_prompt'],
    },
  },
  'grok/grok-imagine-tokens': {
    provider: 'grok',
    id: 'grok-imagine-tokens',
    name: 'Grok Imagine Tokens',
    kind: 'image',
    endpointId: 'v1/images/generations',
    card: PER_TOKEN,
    inputSchema: VIDEO_SCHEMA,
  },
};

const getGatewayModel = vi.fn(async (provider: GatewayProvider, id: string) => {
  const model = MODELS[`${provider}/${id}`];
  if (!model) throw new NotFoundError('Unknown model');
  return model;
});
const triggerWorkflow = vi.fn(async () => 'run-1');
const requireCheckedUploadRights = vi.fn(
  async (
    _scopedDb: {
      apiKeys: { resolveLlmKey: (model: string) => Promise<unknown> };
    },
    _urls: string[],
    _request: unknown
  ) => new Map()
);

vi.doMock('#db-client', () => ({ getDb: () => db }));
vi.doMock('@/gateway/server/catalog', () => ({ getGatewayModel }));
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/cast/server/upload-check', () => ({ requireCheckedUploadRights }));
vi.doMock('@/platform/server/compliance/generation-gate', () => ({
  requireGenerationAllowed: vi.fn(async () => undefined),
}));

const { submitGatewayJob, gatedUrls, readIdempotencyKey } =
  await import('./submit-job');
const { readGatewayJob } = await import('./read-job');
const { createScopedDb } = await import('@/platform/server/db/scoped');

const organizationId = generateId();
const otherOrganizationId = generateId();
const brokeOrganizationId = generateId();
const userId = generateId();
const request = { ipAddress: '203.0.113.9', userAgent: 'vitest' };

const PROMPT =
  'Mara, a ferry mechanic, wipes her hands on a rag in the engine room';
const BODY: GatewayJobInput = { prompt: PROMPT, duration: 5 };
const VIDEO = {
  provider: 'grok',
  modelId: 'grok-imagine-video',
  body: BODY,
} as const;

function ctx(
  scopedDb: ReturnType<typeof createScopedDb>,
  idempotencyKey: string | null = null
) {
  return { scopedDb, request, idempotencyKey, oauthClientId: null };
}

async function reservationsFor(orgId: string) {
  return db
    .select()
    .from(creditReservations)
    .where(eq(creditReservations.organizationId, orgId));
}

async function jobsFor(orgId: string) {
  return db
    .select()
    .from(gatewayJobs)
    .where(eq(gatewayJobs.organizationId, orgId));
}

/** Runs a submit that must be refused, and checks it left no row and no hold. */
async function refused(
  submit: Parameters<typeof submitGatewayJob>[0]
): Promise<unknown> {
  const scopedDb = createScopedDb(organizationId, userId);
  const jobs = (await jobsFor(organizationId)).length;
  const holds = (await reservationsFor(organizationId)).length;
  const error = await submitGatewayJob(submit, ctx(scopedDb)).catch(
    (e: unknown) => e
  );
  expect((await jobsFor(organizationId)).length).toBe(jobs);
  expect((await reservationsFor(organizationId)).length).toBe(holds);
  expect(triggerWorkflow).not.toHaveBeenCalled();
  return error;
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
});

afterAll(async () => {
  await closeDb();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('submitGatewayJob', () => {
  it('holds the card price and triggers one run, even with an own key on file', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    expect(await scopedDb.apiKeys.hasUsableKey('fal')).toBe(true);

    const { job, replay } = await submitGatewayJob(VIDEO, ctx(scopedDb));
    expect(replay).toBe(false);
    // The path's model is written onto the body: the schema has a `model`.
    const input = { model: 'grok-imagine-video', prompt: PROMPT, duration: 5 };
    expect(job).toMatchObject({
      status: 'queued',
      kind: 'video',
      modelKey: 'grok-imagine-video',
      via: 'xai',
      input,
      workflowRunId: 'run-1',
    });
    expect(job.reservationId).toEqual(expect.any(String));

    // 5 seconds at $0.08.
    const [hold] = (await reservationsFor(organizationId)).filter(
      (row) => row.id === job.reservationId
    );
    expect(hold).toMatchObject({
      originalAmount: 400_000,
      remainingAmount: 400_000,
    });

    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/gateway',
      {
        userId,
        organizationId,
        reservationId: job.reservationId,
        ownsReservation: true,
        jobId: job.id,
        provider: 'grok',
        kind: 'video',
        target: {
          modelId: 'grok-imagine-video',
          endpointId: 'v1/videos/generations',
        },
        card: PER_SECOND,
        input,
        holdMicros: 400_000,
      },
      { deduplicationId: `gateway-${job.id}` }
    );
  });

  it('accepts the same model in the body and refuses a different one', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(
      { ...VIDEO, body: { ...BODY, model: 'grok-imagine-video' } },
      ctx(scopedDb)
    );
    expect(job.input).toMatchObject({ model: 'grok-imagine-video' });

    vi.clearAllMocks();
    const error = await refused({
      ...VIDEO,
      body: { ...BODY, model: 'grok-imagine-image' },
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: '`model` in the body differs from the path',
    });
  });

  it('leaves the body as sent when the schema has no model', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(
      { provider: 'fal', modelId: 'fal-ai/ferry/video', body: BODY },
      ctx(scopedDb)
    );
    expect(job).toMatchObject({
      modelKey: 'fal-ai/ferry/video',
      via: 'fal',
      input: BODY,
    });
    expect(job.input).not.toHaveProperty('model');
  });

  it('runs the path model even when the schema has no model field', async () => {
    const loose = { provider: 'grok', modelId: 'grok-imagine-loose' } as const;
    const error = await refused({
      ...loose,
      body: { ...BODY, model: 'grok-imagine-video-pro' },
    });
    expect(error).toMatchObject({
      message: '`model` in the body differs from the path',
    });

    const scopedDb = createScopedDb(organizationId, userId);
    const { job } = await submitGatewayJob(
      { ...loose, body: BODY },
      ctx(scopedDb)
    );
    // xAI reads the model off the body, so the priced one is written there.
    expect(job.input).toMatchObject({ model: 'grok-imagine-loose' });
  });

  it('refuses a field the schema does not name', async () => {
    const error = await refused({
      ...VIDEO,
      body: { ...BODY, resolution: '4k' },
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: 'The model schema has no field named resolution',
    });
  });

  it('refuses more than one output when the card does not price the count', async () => {
    const loose = { provider: 'grok', modelId: 'grok-imagine-loose' } as const;
    const error = await refused({ ...loose, body: { ...BODY, n: 4 } });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: 'The rate card does not price `n` above 1 for this model',
    });

    const scopedDb = createScopedDb(organizationId, userId);
    await expect(
      submitGatewayJob({ ...loose, body: { ...BODY, n: 1 } }, ctx(scopedDb))
    ).resolves.toMatchObject({ replay: false });
  });

  it('refuses a body the schema refuses, with no row and no hold', async () => {
    const error = await refused({
      ...VIDEO,
      body: { prompt: PROMPT, duration: 'five' },
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: 'The body does not match the model schema',
      details: { issues: [expect.objectContaining({ path: 'duration' })] },
    });
    expect(requireCheckedUploadRights).not.toHaveBeenCalled();
  });

  it('refuses an unknown model before anything else', async () => {
    const error = await refused({ ...VIDEO, modelId: 'grok-imagine-nothing' });
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it('refuses inline media', async () => {
    const dataUri = await refused({
      ...VIDEO,
      body: { ...BODY, image: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    });
    expect(dataUri).toBeInstanceOf(ValidationError);

    const inline = await refused({
      ...VIDEO,
      body: {
        ...BODY,
        content: [
          { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
        ],
      },
    });
    expect(inline).toBeInstanceOf(ValidationError);
    expect(requireCheckedUploadRights).not.toHaveBeenCalled();
  });

  it('refuses a Seed Audio voice cloned from a clip, which the check cannot hear', async () => {
    const error = await refused({
      provider: 'byteplus',
      modelId: 'seed-audio-1.0',
      body: {
        text_prompt: '@Audio1 says the port engine is done for',
        duration: 5,
        references: [{ audio_url: 'https://a.example/mara.wav' }],
      },
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(requireCheckedUploadRights).not.toHaveBeenCalled();
  });

  it('checks every URL in the body before anything spends', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const body: GatewayJobInput = {
      ...BODY,
      image: { url: 'https://media.example.com/mara.png' },
      content: [
        {
          type: 'image_url',
          image_url: { url: 'HTTP://media.example.com/engine-room.png' },
        },
        { type: 'text', text: 'not a url: /r2/x.png' },
      ],
    };
    const submit = { ...VIDEO, body };
    requireCheckedUploadRights.mockRejectedValueOnce(
      new AttestationRequiredError('needs a portrait attestation')
    );
    expect(await refused(submit)).toBeInstanceOf(AttestationRequiredError);
    expect(requireCheckedUploadRights).toHaveBeenCalledWith(
      expect.anything(),
      [
        'https://media.example.com/mara.png',
        'HTTP://media.example.com/engine-room.png',
      ],
      request
    );

    // Cleared, the same body runs.
    const { replay } = await submitGatewayJob(submit, ctx(scopedDb));
    expect(replay).toBe(false);
  });

  it('refuses a request the card cannot price, with no row and no hold', async () => {
    const error = await refused({
      provider: 'grok',
      modelId: 'grok-imagine-tokens',
      body: BODY,
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      message: expect.stringContaining('cannot be priced before it runs'),
    });
  });

  it('runs the likeness check on the platform LLM key, never the organization key', async () => {
    vi.stubEnv('OPENROUTER_KEY', 'platform-openrouter');
    try {
      const scopedDb = createScopedDb(organizationId, userId);
      scopedDb.apiKeys.resolveLlmKey = async () => {
        throw new Error('organization LLM key resolved');
      };
      await submitGatewayJob(VIDEO, ctx(scopedDb));
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
    const first = await submitGatewayJob(VIDEO, ctx(scopedDb, 'retry-1'));
    const holdsAfterFirst = (await reservationsFor(organizationId)).length;
    const again = await submitGatewayJob(VIDEO, ctx(scopedDb, 'retry-1'));
    expect(again).toEqual({ job: first.job, replay: true });
    expect(triggerWorkflow).toHaveBeenCalledTimes(1);
    // A replay answers before the model is looked up.
    expect(getGatewayModel).toHaveBeenCalledTimes(1);
    expect((await reservationsFor(organizationId)).length).toBe(
      holdsAfterFirst
    );
  });

  it('refuses for credits with a 402 and leaves no job behind', async () => {
    const scopedDb = createScopedDb(brokeOrganizationId, userId);
    const error = await submitGatewayJob(VIDEO, ctx(scopedDb, 'broke-1')).catch(
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
    expect(await jobsFor(brokeOrganizationId)).toEqual([]);

    // Topped up, the same key now runs.
    await db
      .update(credits)
      .set({ balance: 100_000_000 })
      .where(eq(credits.organizationId, brokeOrganizationId));
    const { replay } = await submitGatewayJob(VIDEO, ctx(scopedDb, 'broke-1'));
    expect(replay).toBe(false);
  });

  it('marks the job NOT_STARTED and zeroes the hold when the trigger fails', async () => {
    const scopedDb = createScopedDb(organizationId, userId);
    const before = new Set(
      (await reservationsFor(organizationId)).map((row) => row.id)
    );
    triggerWorkflow.mockRejectedValueOnce(new Error('binding down'));
    await expect(
      submitGatewayJob(VIDEO, ctx(scopedDb, 'trigger-fails'))
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
    const made = (await reservationsFor(organizationId)).filter(
      (row) => !before.has(row.id)
    );
    expect(made).toMatchObject([
      { originalAmount: 400_000, remainingAmount: 0 },
    ]);
  });
});

describe('gatedUrls', () => {
  it('finds http(s) URLs and our own /r2 paths at any depth, and nothing else', () => {
    expect(
      gatedUrls({
        prompt: PROMPT,
        duration: 5,
        loop: false,
        mask: null,
        image_urls: ['https://a.example/1.png', '/r2/talent/x/still.png'],
        note: 'a/relative/path.png',
        nested: { deep: [{ url: 'http://a.example/2.png' }] },
      })
    ).toEqual([
      'https://a.example/1.png',
      '/r2/talent/x/still.png',
      'http://a.example/2.png',
    ]);
  });

  it('refuses a data URI and both inline-data spellings', () => {
    expect(() => gatedUrls({ image: 'data:image/png;base64,AAAA' })).toThrow(
      ValidationError
    );
    expect(() => gatedUrls({ parts: [{ inlineData: {} }] })).toThrow(
      ValidationError
    );
    expect(() => gatedUrls({ parts: [{ inline_data: {} }] })).toThrow(
      ValidationError
    );
    // Seed Audio's references: bare base64, no `data:` prefix.
    for (const key of ['audio_data', 'image_data']) {
      expect(() => gatedUrls({ references: [{ [key]: 'UklGRg==' }] })).toThrow(
        ValidationError
      );
    }
  });

  it('refuses inline data however it is spelled', () => {
    for (const value of [
      'DATA:image/png;base64,AAAA',
      ' data:image/png;base64,AAAA',
      'data:,AAAA',
      'blob:https://a.example/123',
    ]) {
      expect(() => gatedUrls({ image: value })).toThrow(
        'Send media as a URL, not inline data'
      );
    }
  });

  it('refuses a URL a provider could fetch but the check would not see', () => {
    for (const value of [
      ' https://a.example/1.png',
      '//a.example/1.png',
      'gs://bucket/1.png',
      's3://bucket/1.png',
      'ftp://a.example/1.png',
      'file:///etc/passwd',
    ]) {
      expect(() => gatedUrls({ image: value })).toThrow(
        'Media URLs must be plain http(s) URLs'
      );
    }
  });

  it('leaves a prompt alone that only looks like a scheme', () => {
    expect(
      gatedUrls({
        prompt: 'Data: the ferry log, read aloud. Mara: "Scene one."',
        note: 'blob: a shapeless thing',
      })
    ).toEqual([]);
  });
});

describe('readIdempotencyKey', () => {
  it('trims the header, reads a blank one as none and refuses a long one', () => {
    expect(readIdempotencyKey(new Headers())).toBeNull();
    expect(readIdempotencyKey(new Headers({ 'idempotency-key': '  ' }))).toBe(
      null
    );
    expect(
      readIdempotencyKey(new Headers({ 'Idempotency-Key': ' retry-1 ' }))
    ).toBe('retry-1');
    expect(() =>
      readIdempotencyKey(new Headers({ 'idempotency-key': 'k'.repeat(256) }))
    ).toThrow(ValidationError);
  });
});

describe('readGatewayJob', () => {
  it("is a 404 for another organization's job", async () => {
    const own = createScopedDb(organizationId, userId);
    const other = createScopedDb(otherOrganizationId, userId);
    const { job } = await submitGatewayJob(VIDEO, ctx(own));

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
