/**
 * GatewayGenerationWorkflow with the drivers mocked: step names, media stored
 * in the step that received it, the settle against the rate card and the
 * hold, platform credentials on every driver call, and the failure paths.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { micros } from '@/billing/money';
import { generateId } from '@/platform/id';
import * as realProvenance from '@/platform/server/compliance/provenance';
import { organization, user } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { createTestDb } from '@/platform/server/db/test-d1';
import type { GatewayJobInput, GatewayJobOutput } from '@/gateway/schema';
import { createGatewayJobsMethods } from '@/gateway/server/db/gateway-jobs';
import type {
  GatewayMedia,
  GatewayPoll,
  GatewayStart,
} from '@/gateway/server/providers';
import { asStub } from '@/test/as-stub';
import { rateCardSchema } from '@modelschemas/rate-card/schema';
import type { GatewayGenerationWorkflowInput } from './gateway-generation-workflow';

// The step a mocked write ran in, so a test can pin two writes to one step.
let currentStep = '';
const order: string[] = [];

const mockStart = vi.fn<(...args: unknown[]) => Promise<GatewayStart>>();
const mockPoll = vi.fn<(...args: unknown[]) => Promise<GatewayPoll>>();
const mockDeduct = vi.fn(async (_charge: unknown) => {
  order.push(`${currentStep}:deduct`);
});
const mockRecordProvenance = vi.fn(async () => undefined);
const mockStore = vi.fn(
  async (params: {
    media: GatewayMedia;
    index: number;
  }): Promise<GatewayJobOutput> => ({
    url: `/r2/output-${params.index}.png`,
    path: `output-${params.index}.png`,
    contentType: 'image/png',
  })
);

vi.doMock('#env', () => ({
  getEnv: () => ({ FAL_KEY: 'platform-fal', E2E_TEST: undefined }),
}));
vi.doMock('#db-client', () => ({ getDb: vi.fn() }));
vi.doMock('@/gateway/server/providers', () => ({
  GATEWAY_DRIVERS: {
    fal: { start: mockStart, poll: mockPoll },
    grok: { start: mockStart, poll: mockPoll },
    byteplus: { start: mockStart, poll: mockPoll },
    gemini: { start: mockStart, poll: mockPoll },
  },
}));
vi.doMock('@/gateway/server/storage', () => ({
  storeGatewayOutput: mockStore,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeduct,
}));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  ...realProvenance,
  recordProvenance: mockRecordProvenance,
}));

// For the full `run()`: the base class builds its own scoped db.
const zeroReservation = vi.fn(async () => undefined);
const runMarkFailed = vi.fn(async () => undefined);
type GatewayJobsMethods = ReturnType<typeof createGatewayJobsMethods>;
const runScopedDb: {
  billing: { zeroReservation: typeof zeroReservation };
  gatewayJobs: Partial<GatewayJobsMethods>;
  provenance: object;
} = {
  billing: { zeroReservation },
  gatewayJobs: {
    markRunning: vi.fn(async () => undefined),
    markFailed: runMarkFailed,
  },
  provenance: {},
};
vi.doMock('@/platform/server/db/scoped', () => ({
  createScopedDb: vi.fn(() => runScopedDb),
}));
vi.doMock('@/billing/server/seed-model-pricing', () => ({
  ensureE2eModelPricing: async () => {},
}));
vi.doMock('@/models/server/fal-config', () => ({
  configureFalProxyFromEnv: vi.fn(),
}));
vi.doMock('@/platform/server/observability/flush-analytics', () => ({
  flushAnalytics: vi.fn(async () => undefined),
}));
vi.doMock('@/platform/server/observability/product-events', () => ({
  captureProductEvent: vi.fn(),
}));

const { GatewayGenerationWorkflow, gatewayErrorCode } =
  await import('./gateway-generation-workflow');
const { settleGatewayJob } = await import('@/gateway/server/settle');

type Event = Readonly<WorkflowEvent<GatewayGenerationWorkflowInput>>;

class Probe extends GatewayGenerationWorkflow {
  runBody(event: Event, step: WorkflowStep, scopedDb: WorkflowScopedDb) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  return new Probe(asStub<Ctor[0]>(undefined), asStub<Ctor[1]>({}));
}

type ProbeStep = WorkflowStep & {
  names: string[];
  /** What each step returned: the value a checkpoint would hold. */
  results: Record<string, unknown>;
};

function makeStep(): ProbeStep {
  const names: string[] = [];
  const results: Record<string, unknown> = {};
  return asStub<ProbeStep>({
    names,
    results,
    do: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
      names.push(name);
      currentStep = name;
      const result = await fn();
      results[name] = result;
      return result;
    }),
    sleep: vi.fn(async () => {}),
  });
}

function makeScopedDb() {
  const gatewayJobs = {
    markRunning: vi.fn(async () => undefined),
    stampProviderJob: vi.fn(async () => undefined),
    markSucceeded: vi.fn(async (_id: string, _result: unknown) => {
      order.push(`${currentStep}:markSucceeded`);
    }),
    markFailed: vi.fn(async () => undefined),
  };
  // Organization credentials throw: a gateway run must never reach them.
  const refuse = () => {
    throw new Error('organization credentials used');
  };
  const scopedDb = asStub<WorkflowScopedDb>({
    organizationId: 'org-1',
    gatewayJobs,
    provenance: {},
    credentials: { resolveKey: refuse, resolveOptionalKey: refuse },
  });
  return { scopedDb, gatewayJobs };
}

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

// $10 a million output tokens, read off the usage.
const PER_TOKEN = rateCardSchema.parse({
  inputs: {
    output_tokens: { param: 'output_tokens', bound: 'usage', kind: 'number' },
  },
  tables: {},
  price: { '*': [{ var: 'output_tokens' }, 0.00001] },
  examples: [],
  source: SOURCE,
});

const INPUT: GatewayJobInput = {
  model: 'grok-imagine-video',
  prompt: 'Mara, a ferry mechanic, wipes her hands on a rag in the engine room',
  duration: 5,
};
const TARGET = {
  modelId: 'grok-imagine-video',
  endpointId: 'v1/videos/generations',
};
const HOLD = micros(500_000);
// A PNG header: stands for the megabytes a real answer carries.
const BASE64 = 'iVBORw0KGgoAAAANSUhEUg==';

function makeEvent(
  overrides: Partial<GatewayGenerationWorkflowInput> = {}
): Event {
  return {
    payload: {
      userId: 'u1',
      organizationId: 'org-1',
      jobId: 'job-1',
      reservationId: 'res-1',
      ownsReservation: true,
      provider: 'grok',
      kind: 'video',
      target: TARGET,
      card: PER_SECOND,
      input: INPUT,
      holdMicros: HOLD,
      ...overrides,
    },
    instanceId: 'run-1',
    workflowName: 'gateway',
    timestamp: new Date(0),
  };
}

const SYNC: GatewayStart = {
  result: {
    media: [
      { base64: BASE64, contentType: 'image/png' },
      { url: 'https://imgen.example.com/b.png', contentType: null },
    ],
    usage: { output_tokens: 12_000, total_tokens: 15_000 },
    requestId: 'req-1',
  },
};
const OUTPUTS = [
  { url: '/r2/output-0.png', path: 'output-0.png', contentType: 'image/png' },
  { url: '/r2/output-1.png', path: 'output-1.png', contentType: 'image/png' },
];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mockStart.mockResolvedValue(SYNC);
  mockPoll.mockResolvedValue({
    status: 'done',
    result: {
      media: [{ url: 'https://vidgen.example.com/a.mp4', contentType: null }],
      usage: null,
      requestId: 'provider-1',
    },
  });
  mockRecordProvenance.mockResolvedValue(undefined);
});

describe('GatewayGenerationWorkflow, an answer at once', () => {
  it('stores the media inside the start step: no bytes cross a checkpoint', async () => {
    const step = makeStep();
    const { scopedDb } = makeScopedDb();
    const result = await makeWorkflow().runBody(makeEvent(), step, scopedDb);

    expect(step.names).toEqual([
      'set-running',
      'start',
      'settle',
      'record-provenance',
    ]);
    expect(step.results.start).toEqual({
      stored: {
        outputs: OUTPUTS,
        usage: { output_tokens: 12_000, total_tokens: 15_000 },
        requestId: 'req-1',
      },
    });
    for (const checkpoint of Object.values(step.results)) {
      expect(JSON.stringify(checkpoint ?? null)).not.toContain(BASE64);
    }
    expect(mockStore.mock.calls.map(([params]) => params)).toEqual([
      {
        media: { base64: BASE64, contentType: 'image/png' },
        kind: 'video',
        organizationId: 'org-1',
        jobId: 'job-1',
        index: 0,
      },
      {
        media: { url: 'https://imgen.example.com/b.png', contentType: null },
        kind: 'video',
        organizationId: 'org-1',
        jobId: 'job-1',
        index: 1,
      },
    ]);
    expect(mockPoll).not.toHaveBeenCalled();
    expect(result).toEqual({ jobId: 'job-1', outputs: OUTPUTS });
  });

  it("sends the caller's body to the provider's driver on platform keys", async () => {
    const { scopedDb } = makeScopedDb();
    await makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb);
    expect(mockStart).toHaveBeenCalledWith(TARGET, INPUT, expect.anything());
    const credentials = asStub<{
      resolveKey: (provider: string) => Promise<unknown>;
    }>(mockStart.mock.calls[0]?.[2]);
    expect(await credentials.resolveKey('fal')).toEqual({
      key: 'platform-fal',
      source: 'platform',
    });
  });

  it('charges the card for the request and marks the job in the settle step', async () => {
    const { scopedDb, gatewayJobs } = makeScopedDb();
    await makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb);

    // 5 seconds at $0.08, not the $0.50 hold.
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(400_000),
        usedOwnKey: false,
        reservationId: 'res-1',
        idempotencyKey: 'run-1:gateway-settle',
        description: 'Gateway (grok/grok-imagine-video)',
        metadata: {
          provider: 'grok',
          model: 'grok-imagine-video',
          requestId: 'req-1',
          gatewayJobId: 'job-1',
        },
      })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith('job-1', {
      outputs: OUTPUTS,
      costMicros: micros(400_000),
      via: 'xai',
    });
    expect(order).toEqual(['settle:deduct', 'settle:markSucceeded']);
    expect(mockRecordProvenance).toHaveBeenCalledTimes(2);
    expect(mockRecordProvenance).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        assetKind: 'gateway_job',
        assetId: 'job-1',
        storageKey: 'output-1.png',
        provider: 'xai',
        model: 'grok-imagine-video',
        providerRequestId: 'req-1',
        prompt: INPUT.prompt,
      })
    );
  });

  it('prices a usage card with the usage the provider reported', async () => {
    const { scopedDb, gatewayJobs } = makeScopedDb();
    await makeWorkflow().runBody(
      makeEvent({ card: PER_TOKEN }),
      makeStep(),
      scopedDb
    );
    // 12,000 output tokens at $10 a million.
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({ costMicros: micros(120_000) })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(120_000) })
    );
  });

  it('charges the hold when the card refuses the usage', async () => {
    mockStart.mockResolvedValueOnce({
      result: { ...SYNC.result, usage: null },
    });
    const { scopedDb, gatewayJobs } = makeScopedDb();
    await makeWorkflow().runBody(
      makeEvent({ card: PER_TOKEN }),
      makeStep(),
      scopedDb
    );
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: HOLD,
        reservationId: 'res-1',
        idempotencyKey: 'run-1:gateway-settle',
        metadata: expect.objectContaining({ chargedHold: true }),
      })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: HOLD })
    );
  });

  it('fails without settling when the answer holds no media', async () => {
    mockStart.mockResolvedValueOnce({
      result: { media: [], usage: null, requestId: null },
    });
    const { scopedDb, gatewayJobs } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb)
    ).rejects.toThrow('The model returned no output files');
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });
});

describe('GatewayGenerationWorkflow, a queued job', () => {
  it('stamps the provider job, polls it, stores in the poll step, then settles', async () => {
    mockStart.mockResolvedValueOnce({ jobId: 'provider-1' });
    const step = makeStep();
    const { scopedDb, gatewayJobs } = makeScopedDb();
    await makeWorkflow().runBody(makeEvent(), step, scopedDb);

    expect(step.names).toEqual([
      'set-running',
      'start',
      'stamp-provider-job',
      'poll-batch-0',
      'settle',
      'record-provenance',
    ]);
    expect(step.results.start).toEqual({ providerJobId: 'provider-1' });
    expect(gatewayJobs.stampProviderJob).toHaveBeenCalledWith('job-1', {
      via: 'xai',
      providerJobId: 'provider-1',
    });
    expect(mockPoll).toHaveBeenCalledWith(
      TARGET,
      'provider-1',
      expect.anything()
    );
    expect(step.results['poll-batch-0']).toEqual({
      kind: 'stored',
      stored: {
        outputs: [OUTPUTS[0]],
        usage: null,
        requestId: 'provider-1',
      },
    });
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(400_000),
        reservationId: 'res-1',
      })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(400_000), via: 'xai' })
    );
  });

  it('fails without storing or settling when the provider fails the job', async () => {
    mockStart.mockResolvedValueOnce({ jobId: 'provider-1' });
    mockPoll.mockResolvedValueOnce({ status: 'failed', error: 'boom' });
    const { scopedDb, gatewayJobs } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb)
    ).rejects.toThrow('boom');
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });
});

describe('failure', () => {
  it('marks the job failed and releases the hold through the base class', async () => {
    mockStart.mockRejectedValueOnce(new Error('provider down'));
    await expect(makeWorkflow().run(makeEvent(), makeStep())).rejects.toThrow(
      'provider down'
    );
    expect(zeroReservation).toHaveBeenCalledWith('res-1');
    expect(runMarkFailed).toHaveBeenCalledWith('job-1', {
      code: 'GENERATION_FAILED',
      message: expect.stringContaining('provider down'),
    });
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('names a content refusal', () => {
    expect(gatewayErrorCode('Content policy violation: flagged')).toBe(
      'CONTENT_REJECTED'
    );
    expect(gatewayErrorCode('timeout')).toBe('GENERATION_FAILED');
  });

  it('settle never bills an own-key result', async () => {
    await expect(
      settleGatewayJob({
        scopedDb: makeScopedDb().scopedDb,
        jobId: 'job-1',
        model: 'grok/grok-imagine-video',
        reservationId: 'res-1',
        costMicros: micros(1),
        holdMicros: micros(1),
        usedOwnKey: true,
        idempotencyKey: 'k',
      })
    ).rejects.toThrow('organization key');
    expect(mockDeduct).not.toHaveBeenCalled();
  });
});

describe('a throw after the settle', () => {
  const organizationId = generateId();
  const userId = generateId();
  let closeDb: (() => Promise<void>) | undefined;
  const mockedJobs = runScopedDb.gatewayJobs;

  afterAll(async () => {
    runScopedDb.gatewayJobs = mockedJobs;
    await closeDb?.();
  });

  it('leaves the job succeeded: the failure write only moves a live row', async () => {
    const { db, close } = await createTestDb();
    closeDb = close;
    await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
    await db
      .insert(organization)
      .values({ id: organizationId, name: 'T', slug: 't' });
    // The real rows, so the guard on `markFailed` is the one under test.
    const jobs = createGatewayJobsMethods(db, organizationId, userId);
    runScopedDb.gatewayJobs = jobs;
    const { job } = await jobs.create({
      kind: 'video',
      modelKey: TARGET.modelId,
      via: 'xai',
      input: INPUT,
      idempotencyKey: null,
      oauthClientId: null,
    });
    const markFailed = vi.spyOn(jobs, 'markFailed');
    mockRecordProvenance.mockRejectedValue(new Error('provenance insert lost'));

    const step = makeStep();
    await expect(
      makeWorkflow().run(
        makeEvent({ organizationId, userId, jobId: job.id }),
        step
      )
    ).rejects.toThrow('provenance insert lost');

    expect(step.names).toEqual([
      'set-running',
      'start',
      'settle',
      'record-provenance',
      'emit-failure',
    ]);
    expect(mockDeduct).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(job.id, {
      code: 'GENERATION_FAILED',
      message: expect.stringContaining('provenance insert lost'),
    });
    expect(await jobs.getById(job.id)).toMatchObject({
      status: 'succeeded',
      outputs: OUTPUTS,
      costMicros: 400_000,
      error: null,
    });
  });
});
