/**
 * GatewayGenerationWorkflow with the drivers mocked: step names, media stored
 * in the step that received it, the charge lines settled against the hold,
 * success written in the settle step, platform credentials on every driver
 * call, and the failure paths.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { micros } from '@/billing/money';
import {
  createBillingMethods,
  type SettleReservationResult,
} from '@/billing/server/db/billing';
import { generateId } from '@/platform/id';
import * as realProvenance from '@/platform/server/compliance/provenance';
import {
  chargeLines,
  credits,
  organization,
  user,
} from '@/platform/server/db/schema';
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
import { eq } from 'drizzle-orm';
import type { GatewayGenerationWorkflowInput } from './gateway-generation-workflow';

// The step a mocked write ran in, so a test can pin writes to their steps.
let currentStep = '';
const order: string[] = [];

const mockStart = vi.fn<(...args: unknown[]) => Promise<GatewayStart>>();
const mockPoll = vi.fn<(...args: unknown[]) => Promise<GatewayPoll>>();
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
vi.doMock('@/platform/server/compliance/provenance', () => ({
  ...realProvenance,
  recordProvenance: mockRecordProvenance,
}));

// For the full `run()`: the base class builds its own scoped db.
const zeroReservation = vi.fn(async (_reservationId: string) => undefined);
const runMarkFailed = vi.fn(async () => true);
type GatewayJobsMethods = ReturnType<typeof createGatewayJobsMethods>;
type BillingMethods = ReturnType<typeof createBillingMethods>;
const runScopedDb: {
  organizationId: string;
  billing: Partial<BillingMethods>;
  gatewayJobs: Partial<GatewayJobsMethods>;
  provenance: object;
} = {
  organizationId: 'org-1',
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

/** `retry` runs a step that threw once more, as the engine would. */
function makeStep(opts: { retry?: boolean } = {}): ProbeStep {
  const names: string[] = [];
  const results: Record<string, unknown> = {};
  return asStub<ProbeStep>({
    names,
    results,
    do: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
      names.push(name);
      currentStep = name;
      const result = opts.retry ? await fn().catch(() => fn()) : await fn();
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
    recordOutputs: vi.fn(async (_id: string, _result: unknown) => {
      order.push(`${currentStep}:recordOutputs`);
    }),
    markSucceeded: vi.fn(async (_id: string, _result: unknown) => {
      order.push(`${currentStep}:markSucceeded`);
    }),
    markFailed: vi.fn(async () => undefined),
  };
  const billing = {
    settleReservation: vi.fn(
      async (
        _reservationId: string,
        lines: readonly { amountMicros: number }[],
        _opts: { idempotencyKey: string }
      ): Promise<SettleReservationResult> => {
        order.push(`${currentStep}:settleReservation`);
        return {
          ok: true,
          captured: micros(
            lines.reduce((sum, line) => sum + line.amountMicros, 0)
          ),
          transactionId: 'tx-1',
          lines: [],
          replay: false,
        };
      }
    ),
    checkAutoTopUp: vi.fn(async () => undefined),
  };
  // Organization credentials throw: a gateway run must never reach them.
  const refuse = () => {
    throw new Error('organization credentials used');
  };
  const scopedDb = asStub<WorkflowScopedDb>({
    organizationId: 'org-1',
    gatewayJobs,
    billing,
    provenance: {},
    credentials: { resolveKey: refuse, resolveOptionalKey: refuse },
  });
  return { scopedDb, gatewayJobs, billing };
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
// What submit priced the request at: 5 seconds at $0.08.
const ESTIMATE = micros(400_000);
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
      estimateMicros: ESTIMATE,
      platformFeeBps: 0,
      oauthClientId: 'client-1',
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

const providerCost = (amountMicros: number) => ({
  kind: 'provider_cost',
  amountMicros,
  payeeOrganizationId: null,
});
const platformFee = (amountMicros: number) => ({
  kind: 'platform_fee',
  amountMicros,
  payeeOrganizationId: null,
});

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
      'record-provenance',
      'record-outputs',
      'settle',
    ]);
    expect(step.results.start).toEqual({
      stored: {
        outputs: OUTPUTS,
        usageJson: JSON.stringify({
          output_tokens: 12_000,
          total_tokens: 15_000,
        }),
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

  it('records the outputs, then settles the card price and succeeds in one step', async () => {
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb);

    expect(gatewayJobs.recordOutputs).toHaveBeenCalledWith('job-1', {
      outputs: OUTPUTS,
      via: 'xai',
    });
    // 5 seconds at $0.08.
    expect(billing.settleReservation).toHaveBeenCalledWith(
      'res-1',
      [providerCost(400_000)],
      {
        idempotencyKey: 'run-1:gateway-settle',
        description: 'Gateway (grok/grok-imagine-video)',
        metadata: {
          provider: 'grok',
          model: 'grok-imagine-video',
          requestId: 'req-1',
          gatewayJobId: 'job-1',
        },
        attribution: { gatewayJobId: 'job-1', oauthClientId: 'client-1' },
      }
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith('job-1', {
      outputs: OUTPUTS,
      costMicros: micros(400_000),
      via: 'xai',
    });
    expect(order).toEqual([
      'record-outputs:recordOutputs',
      'settle:settleReservation',
      'settle:markSucceeded',
    ]);
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
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await makeWorkflow().runBody(
      makeEvent({ card: PER_TOKEN }),
      makeStep(),
      scopedDb
    );
    // 12,000 output tokens at $10 a million, not the estimate.
    expect(billing.settleReservation.mock.calls[0]?.[1]).toEqual([
      providerCost(120_000),
    ]);
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(120_000) })
    );
  });

  it('adds the platform fee snapshotted on the payload', async () => {
    const { scopedDb, billing, gatewayJobs } = makeScopedDb();
    await makeWorkflow().runBody(
      makeEvent({ platformFeeBps: 1_000 }),
      makeStep(),
      scopedDb
    );
    expect(billing.settleReservation.mock.calls[0]?.[1]).toEqual([
      providerCost(400_000),
      platformFee(40_000),
    ]);
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(440_000) })
    );
  });

  it('charges the lines of the estimate when the card refuses the usage', async () => {
    mockStart.mockResolvedValueOnce({
      result: { ...SYNC.result, usage: null },
    });
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await makeWorkflow().runBody(
      makeEvent({
        card: PER_TOKEN,
        estimateMicros: micros(50_000),
        platformFeeBps: 500,
      }),
      makeStep(),
      scopedDb
    );
    // The hold was the charge on the estimate at this fee: 50_000 + 2_500.
    expect(billing.settleReservation).toHaveBeenCalledWith(
      'res-1',
      [providerCost(50_000), platformFee(2_500)],
      expect.objectContaining({
        idempotencyKey: 'run-1:gateway-settle',
        metadata: expect.objectContaining({ chargedHold: true }),
      })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(52_500) })
    );
  });

  it('fails without settling when the answer holds no media', async () => {
    mockStart.mockResolvedValueOnce({
      result: { media: [], usage: null, requestId: null },
    });
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb)
    ).rejects.toThrow('The model returned no output files');
    expect(gatewayJobs.recordOutputs).not.toHaveBeenCalled();
    expect(billing.settleReservation).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });

  it('a provenance failure fails the job before any charge', async () => {
    mockRecordProvenance.mockRejectedValueOnce(new Error('ledger down'));
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb)
    ).rejects.toThrow('ledger down');
    expect(gatewayJobs.recordOutputs).not.toHaveBeenCalled();
    expect(billing.settleReservation).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });

  it('a failed success write retries the settle step, which replays the charge', async () => {
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    gatewayJobs.markSucceeded.mockRejectedValueOnce(new Error('D1 blip'));
    await makeWorkflow().runBody(
      makeEvent(),
      makeStep({ retry: true }),
      scopedDb
    );
    expect(billing.settleReservation).toHaveBeenCalledTimes(2);
    expect(
      billing.settleReservation.mock.calls.map((call) => call[2].idempotencyKey)
    ).toEqual(['run-1:gateway-settle', 'run-1:gateway-settle']);
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledTimes(2);
  });

  it('reports what a short capture could not charge and succeeds at the debit', async () => {
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    billing.settleReservation.mockResolvedValueOnce({
      ok: true,
      captured: micros(150_000),
      skippedDeltaMicros: micros(250_000),
      transactionId: 'tx-1',
      lines: [],
      replay: false,
    });
    await makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb);
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(150_000) })
    );
    expect(billing.checkAutoTopUp).toHaveBeenCalled();
  });
});

describe('GatewayGenerationWorkflow, a queued job', () => {
  it('stamps the provider job, polls it, stores in the poll step, then settles', async () => {
    mockStart.mockResolvedValueOnce({ jobId: 'provider-1' });
    const step = makeStep();
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await makeWorkflow().runBody(makeEvent(), step, scopedDb);

    expect(step.names).toEqual([
      'set-running',
      'start',
      'stamp-provider-job',
      'poll-batch-0',
      'record-provenance',
      'record-outputs',
      'settle',
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
        usageJson: null,
        requestId: 'provider-1',
      },
    });
    expect(gatewayJobs.recordOutputs).toHaveBeenCalledWith('job-1', {
      outputs: [OUTPUTS[0]],
      via: 'xai',
    });
    expect(billing.settleReservation).toHaveBeenCalledWith(
      'res-1',
      [providerCost(400_000)],
      expect.anything()
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(400_000), via: 'xai' })
    );
  });

  it('polls on in a new batch, after a sleep, when one runs out pending', async () => {
    vi.useFakeTimers();
    try {
      mockStart.mockResolvedValueOnce({ jobId: 'provider-1' });
      // A batch is 30 s of polls 3 s apart: ten pendings use it up.
      for (let i = 0; i < 10; i++) {
        mockPoll.mockResolvedValueOnce({ status: 'pending' });
      }
      const step = makeStep();
      const { scopedDb, billing } = makeScopedDb();
      const run = makeWorkflow().runBody(makeEvent(), step, scopedDb);
      await vi.advanceTimersByTimeAsync(31_000);
      await run;

      expect(step.names).toEqual([
        'set-running',
        'start',
        'stamp-provider-job',
        'poll-batch-0',
        'poll-batch-1',
        'record-provenance',
        'record-outputs',
        'settle',
      ]);
      expect(step.results['poll-batch-0']).toEqual({ kind: 'pending' });
      expect(step.results['poll-batch-1']).toMatchObject({ kind: 'stored' });
      expect(step.sleep).toHaveBeenCalledWith('poll-wait-1', 1);
      expect(mockPoll).toHaveBeenCalledTimes(11);
      expect(mockStore).toHaveBeenCalledTimes(1);
      expect(billing.settleReservation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails without storing or settling when the provider fails the job', async () => {
    mockStart.mockResolvedValueOnce({ jobId: 'provider-1' });
    mockPoll.mockResolvedValueOnce({ status: 'failed', error: 'boom' });
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb)
    ).rejects.toThrow('boom');
    expect(mockStore).not.toHaveBeenCalled();
    expect(billing.settleReservation).not.toHaveBeenCalled();
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
  });

  it('names a content refusal', () => {
    expect(gatewayErrorCode('Content policy violation: flagged')).toBe(
      'CONTENT_REJECTED'
    );
    expect(gatewayErrorCode('timeout')).toBe('GENERATION_FAILED');
  });

  it('settle never bills an own-key result', async () => {
    const { scopedDb, billing, gatewayJobs } = makeScopedDb();
    await expect(
      settleGatewayJob({
        scopedDb,
        jobId: 'job-1',
        model: 'grok/grok-imagine-video',
        reservationId: 'res-1',
        costMicros: micros(1),
        estimateMicros: micros(1),
        platformFeeBps: 0,
        oauthClientId: null,
        usedOwnKey: true,
        idempotencyKey: 'k',
        result: { outputs: OUTPUTS, via: 'xai' },
      })
    ).rejects.toThrow('organization key');
    expect(billing.settleReservation).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });

  it('a job with no hold succeeds uncharged and reports the skip', async () => {
    const { scopedDb, billing, gatewayJobs } = makeScopedDb();
    const charged = await settleGatewayJob({
      scopedDb,
      jobId: 'job-1',
      model: 'grok/grok-imagine-video',
      reservationId: undefined,
      costMicros: micros(1_000),
      estimateMicros: micros(1_000),
      platformFeeBps: 0,
      oauthClientId: null,
      usedOwnKey: false,
      idempotencyKey: 'k',
      result: { outputs: OUTPUTS, via: 'xai' },
    });
    expect(charged).toBe(0);
    expect(billing.settleReservation).not.toHaveBeenCalled();
    expect(billing.checkAutoTopUp).toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: 0 })
    );
  });
});

describe('a throw after the charge', () => {
  const organizationId = generateId();
  const userId = generateId();
  let closeDb: (() => Promise<void>) | undefined;
  const mocked = { ...runScopedDb };

  afterAll(async () => {
    Object.assign(runScopedDb, mocked);
    await closeDb?.();
  });

  it('leaves the job succeeded at its lines: a charged job never reads failed', async () => {
    const { db, close } = await createTestDb();
    closeDb = close;
    await db.insert(user).values({ id: userId, name: 'U', email: 'u@e.com' });
    await db
      .insert(organization)
      .values({ id: organizationId, name: 'T', slug: 't' });
    await db.insert(credits).values({ organizationId, balance: 1_000_000 });
    // The real rows, so the guard on `markFailed` is the one under test.
    const jobs = createGatewayJobsMethods(db, organizationId, userId);
    const billing = createBillingMethods(db, organizationId, userId);
    Object.assign(runScopedDb, { organizationId, gatewayJobs: jobs, billing });
    const { job } = await jobs.create({
      kind: 'video',
      modelKey: TARGET.modelId,
      via: 'xai',
      input: INPUT,
      idempotencyKey: null,
      oauthClientId: null,
    });
    const held = await billing.createReservation(ESTIMATE, {
      idempotencyKey: `gateway:${job.id}`,
    });
    if (!held.ok) throw new Error('fixture reservation failed');
    const markFailed = vi.spyOn(jobs, 'markFailed');
    // The debit and its lines land; the success write after them is lost.
    vi.spyOn(jobs, 'markSucceeded').mockRejectedValue(new Error('D1 blip'));

    const step = makeStep();
    await expect(
      makeWorkflow().run(
        makeEvent({
          organizationId,
          userId,
          jobId: job.id,
          reservationId: held.reservationId,
        }),
        step
      )
    ).rejects.toThrow('D1 blip');

    expect(step.names).toEqual([
      'set-running',
      'start',
      'record-provenance',
      'record-outputs',
      'settle',
      'emit-failure',
    ]);
    expect(markFailed).toHaveBeenCalledWith(job.id, {
      code: 'GENERATION_FAILED',
      message: expect.stringContaining('D1 blip'),
    });
    expect(await jobs.getById(job.id)).toMatchObject({
      status: 'succeeded',
      outputs: OUTPUTS,
      costMicros: 400_000,
      error: null,
    });
    expect(
      await db
        .select({ kind: chargeLines.kind, amount: chargeLines.amountMicros })
        .from(chargeLines)
        .where(eq(chargeLines.gatewayJobId, job.id))
    ).toEqual([{ kind: 'provider_cost', amount: 400_000 }]);
  });
});
