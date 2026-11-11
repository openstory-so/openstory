/**
 * GatewayGenerationWorkflow with the providers mocked: step names, the
 * charge lines settled against the job's hold, platform credentials on every
 * provider call, the via stamp the poll follows, success in the settle step,
 * and the release of the hold on failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { micros } from '@/billing/money';
import type { SettleReservationResult } from '@/billing/server/db/billing';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { GatewayJobInput } from '@/gateway/schema';
import { asStub } from '@/test/as-stub';
import type { GatewayGenerationWorkflowInput } from './gateway-generation-workflow';

const mockGenerateImage = vi.fn();
const mockSubmit = vi.fn();
const mockPoll = vi.fn();
const mockCost = vi.fn();
const mockResolveMotionVia = vi.fn(async () => 'fal' as const);
const mockIngestArkAssets = vi.fn(async () => ({}));

vi.doMock('#env', () => ({
  getEnv: () => ({ FAL_KEY: 'platform-fal', E2E_TEST: undefined }),
}));
vi.doMock('#db-client', () => ({ getDb: vi.fn() }));
vi.doMock('@/stills/server/image-generation', () => ({
  generateImageWithProvider: mockGenerateImage,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  recordFalUsageStep: vi.fn(async () => ({})),
}));
const mockProvenance = vi.fn(async () => undefined);
vi.doMock('@/platform/server/compliance/provenance', () => ({
  recordProvenance: mockProvenance,
}));
vi.doMock('@/gateway/server/storage', () => ({
  uploadGatewayImage: vi.fn(async () => ({
    url: '/r2/a.png',
    path: 'a.png',
    contentType: 'image/png',
  })),
  uploadGatewayVideo: vi.fn(async () => ({
    url: '/r2/a.mp4',
    path: 'a.mp4',
    contentType: 'video/mp4',
  })),
}));
vi.doMock('@/studio/server/studio-video-generation', () => ({
  submitStudioVideoJob: mockSubmit,
  pollStudioVideoJob: mockPoll,
  studioVideoCostFromUsage: mockCost,
  arkStillsForStudio: () => [],
}));
vi.doMock('@/models/server/byteplus-asset-steps', () => ({
  ingestArkAssets: mockIngestArkAssets,
}));
vi.doMock('@/motion/server/motion-generation', () => ({
  resolveMotionVia: mockResolveMotionVia,
}));

// For the full `run()`: the base class builds its own scoped db.
const zeroReservation = vi.fn(async () => undefined);
const runScopedDb = {
  billing: { zeroReservation },
  gatewayJobs: {
    markRunning: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  },
  bytePlusAssets: { releaseOwner: vi.fn(async () => undefined) },
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

function makeStep(): WorkflowStep & { names: string[] } {
  const names: string[] = [];
  return asStub<WorkflowStep & { names: string[] }>({
    names,
    do: vi.fn((name: string, fn: () => Promise<unknown>) => {
      names.push(name);
      return fn();
    }),
    sleep: vi.fn(async () => {}),
  });
}

function makeScopedDb() {
  const gatewayJobs = {
    markRunning: vi.fn(async () => undefined),
    stampProviderJob: vi.fn(async () => undefined),
    recordOutputs: vi.fn(async () => undefined),
    markSucceeded: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
  const billing = {
    settleReservation: vi.fn(
      async (
        _reservationId: string,
        lines: { amountMicros: number }[],
        _opts: { idempotencyKey: string }
      ): Promise<SettleReservationResult> => ({
        ok: true as const,
        captured: micros(
          lines.reduce((sum, line) => sum + line.amountMicros, 0)
        ),
        transactionId: 'tx-1',
        lines: [],
        replay: false,
      })
    ),
    checkAutoTopUp: vi.fn(async () => undefined),
  };
  const bytePlusAssets = { releaseOwner: vi.fn(async () => undefined) };
  // Organization credentials throw: a gateway run must never reach them.
  const refuse = () => {
    throw new Error('organization credentials used');
  };
  const scopedDb = asStub<WorkflowScopedDb>({
    organizationId: 'org-1',
    gatewayJobs,
    billing,
    bytePlusAssets,
    provenance: {},
    credentials: { resolveKey: refuse, resolveOptionalKey: refuse },
  });
  return { scopedDb, gatewayJobs, billing, bytePlusAssets };
}

const IMAGE: GatewayJobInput = {
  kind: 'image',
  model: 'gpt_image_2',
  prompt: 'a fox',
  aspectRatio: '16:9',
  referenceImageUrls: [],
};

const VIDEO: GatewayJobInput = {
  kind: 'video',
  model: 'seedance_v2',
  prompt: 'the fox runs',
  aspectRatio: '16:9',
  duration: 5,
  referenceImageUrls: [],
};

function makeEvent(input: GatewayJobInput): Event {
  return {
    payload: {
      userId: 'u1',
      organizationId: 'org-1',
      jobId: 'job-1',
      reservationId: 'res-1',
      ownsReservation: true,
      input,
      noPersonImages: [],
      estimateMicros: micros(50_000),
      platformFeeBps: 0,
      oauthClientId: 'client-1',
      appId: 'app-1',
    },
    instanceId: 'run-1',
    workflowName: 'gateway',
    timestamp: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateImage.mockResolvedValue({
    imageUrls: ['https://fal.media/a.png'],
    via: 'fal',
    metadata: { cost: micros(12_000), usedOwnKey: false, endpointId: 'e' },
  });
  mockSubmit.mockResolvedValue({
    jobId: 'provider-1',
    modelKey: 'seedance_v2',
    endpointId: 'bytedance/seedance-2.0/text-to-video',
    via: 'fal',
    usedOwnKey: false,
    threadId: 't',
  });
  mockPoll.mockResolvedValue({
    status: 'completed',
    url: 'https://fal.media/a.mp4',
  });
  mockCost.mockResolvedValue({
    endpointId: 'bytedance/seedance-2.0/text-to-video',
    cost: micros(70_000),
    recordFalUsage: false,
  });
});

const IMAGE_OUTPUT = {
  url: '/r2/a.png',
  path: 'a.png',
  contentType: 'image/png',
};

describe('GatewayGenerationWorkflow image', () => {
  it('stores, records provenance and outputs, then settles and succeeds in one step', async () => {
    const step = makeStep();
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    const result = await makeWorkflow().runBody(
      makeEvent(IMAGE),
      step,
      scopedDb
    );

    expect(step.names).toEqual([
      'set-running',
      'generate-image',
      'record-provenance',
      'record-outputs',
      'settle',
    ]);
    const credentials = mockGenerateImage.mock.calls[0]?.[1]?.credentials;
    expect(await credentials.resolveKey('fal')).toEqual({
      key: 'platform-fal',
      source: 'platform',
    });
    expect(gatewayJobs.recordOutputs).toHaveBeenCalledWith('job-1', {
      outputs: [IMAGE_OUTPUT],
      via: 'fal',
    });
    expect(billing.settleReservation).toHaveBeenCalledWith(
      'res-1',
      [
        {
          kind: 'provider_cost',
          amountMicros: micros(12_000),
          payeeOrganizationId: null,
        },
      ],
      expect.objectContaining({
        idempotencyKey: 'run-1:gateway-settle',
        attribution: {
          gatewayJobId: 'job-1',
          oauthClientId: 'client-1',
          appId: 'app-1',
        },
      })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith('job-1', {
      outputs: [IMAGE_OUTPUT],
      costMicros: micros(12_000),
      via: 'fal',
    });
    expect(result).toEqual({ jobId: 'job-1', outputs: [IMAGE_OUTPUT] });
  });

  it('adds the platform fee snapshotted on the payload', async () => {
    const { scopedDb, billing, gatewayJobs } = makeScopedDb();
    const event = makeEvent(IMAGE);
    await makeWorkflow().runBody(
      { ...event, payload: { ...event.payload, platformFeeBps: 1_000 } },
      makeStep(),
      scopedDb
    );
    expect(billing.settleReservation.mock.calls[0]?.[1]).toEqual([
      {
        kind: 'provider_cost',
        amountMicros: 12_000,
        payeeOrganizationId: null,
      },
      { kind: 'platform_fee', amountMicros: 1_200, payeeOrganizationId: null },
    ]);
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(13_200) })
    );
  });

  it('charges the lines of the estimate when the provider reports no cost', async () => {
    mockGenerateImage.mockResolvedValueOnce({
      imageUrls: ['https://fal.media/a.png'],
      via: 'fal',
      metadata: { usedOwnKey: false, endpointId: 'e' },
    });
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    const event = makeEvent(IMAGE);
    await makeWorkflow().runBody(
      { ...event, payload: { ...event.payload, platformFeeBps: 500 } },
      makeStep(),
      scopedDb
    );
    // The hold was the charge on the estimate at this fee: 50_000 + 2_500.
    expect(billing.settleReservation.mock.calls[0]?.[1]).toEqual([
      {
        kind: 'provider_cost',
        amountMicros: 50_000,
        payeeOrganizationId: null,
      },
      { kind: 'platform_fee', amountMicros: 2_500, payeeOrganizationId: null },
    ]);
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(52_500) })
    );
  });

  it('refuses to settle a result that used an organization key', async () => {
    mockGenerateImage.mockResolvedValueOnce({
      imageUrls: ['https://fal.media/a.png'],
      via: 'fal',
      metadata: { cost: micros(12_000), usedOwnKey: true, endpointId: 'e' },
    });
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(IMAGE), makeStep(), scopedDb)
    ).rejects.toThrow('ran on an organization key');
    expect(billing.settleReservation).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });

  it('a provenance failure fails the job before any charge', async () => {
    mockProvenance.mockRejectedValueOnce(new Error('ledger down'));
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(IMAGE), makeStep(), scopedDb)
    ).rejects.toThrow('ledger down');
    expect(billing.settleReservation).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });

  it('a failed success write retries the settle step, which replays the charge', async () => {
    const { scopedDb, gatewayJobs, billing } = makeScopedDb();
    gatewayJobs.markSucceeded.mockRejectedValueOnce(new Error('D1 blip'));
    // A step that throws runs again, as the engine would retry it.
    const names: string[] = [];
    const step = asStub<WorkflowStep>({
      do: vi.fn(async (name: string, fn: () => Promise<unknown>) => {
        names.push(name);
        try {
          return await fn();
        } catch {
          return fn();
        }
      }),
      sleep: vi.fn(async () => {}),
    });
    await makeWorkflow().runBody(makeEvent(IMAGE), step, scopedDb);
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
      captured: micros(5_000),
      skippedDeltaMicros: micros(7_000),
      transactionId: 'tx-1',
      lines: [],
      replay: false,
    });
    await makeWorkflow().runBody(makeEvent(IMAGE), makeStep(), scopedDb);
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(5_000) })
    );
    expect(billing.checkAutoTopUp).toHaveBeenCalled();
  });
});

describe('GatewayGenerationWorkflow video', () => {
  it('stamps the via, polls the stamped job, stores, then settles', async () => {
    const step = makeStep();
    const { scopedDb, gatewayJobs, billing, bytePlusAssets } = makeScopedDb();
    await makeWorkflow().runBody(makeEvent(VIDEO), step, scopedDb);

    expect(step.names).toEqual([
      'set-running',
      'resolve-video-via',
      'submit-video',
      'stamp-provider-job',
      'video-poll-batch-0',
      'release-byteplus-asset-leases',
      'price-video',
      'upload-video',
      'record-provenance',
      'record-outputs',
      'settle',
    ]);
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'text', duration: 5 })
    );
    expect(gatewayJobs.stampProviderJob).toHaveBeenCalledWith('job-1', {
      via: 'fal',
      providerJobId: 'provider-1',
    });
    expect(mockPoll.mock.calls[0]?.[0]).toMatchObject({
      jobId: 'provider-1',
      via: 'fal',
    });
    expect(bytePlusAssets.releaseOwner).toHaveBeenCalledWith('gateway:run-1');
    expect(billing.settleReservation).toHaveBeenCalledWith(
      'res-1',
      [
        {
          kind: 'provider_cost',
          amountMicros: micros(70_000),
          payeeOrganizationId: null,
        },
      ],
      expect.anything()
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(70_000), via: 'fal' })
    );
  });

  it('fails without settling when the provider fails the job', async () => {
    mockPoll.mockResolvedValueOnce({ status: 'failed', error: 'boom' });
    const { scopedDb, billing } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(VIDEO), makeStep(), scopedDb)
    ).rejects.toThrow('boom');
    expect(billing.settleReservation).not.toHaveBeenCalled();
  });
});

describe('failure', () => {
  it('marks the job failed and releases the hold through the base class', async () => {
    mockGenerateImage.mockRejectedValueOnce(new Error('provider down'));
    await expect(
      makeWorkflow().run(makeEvent(IMAGE), makeStep())
    ).rejects.toThrow('provider down');
    expect(zeroReservation).toHaveBeenCalledWith('res-1');
    expect(runScopedDb.gatewayJobs.markFailed).toHaveBeenCalledWith('job-1', {
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
    const { scopedDb, billing } = makeScopedDb();
    await expect(
      settleGatewayJob({
        scopedDb,
        jobId: 'job-1',
        model: 'gpt_image_2',
        reservationId: 'res-1',
        costMicros: micros(1),
        estimateMicros: micros(1),
        platformFeeBps: 0,
        oauthClientId: null,
        usedOwnKey: true,
        idempotencyKey: 'k',
        result: { outputs: [IMAGE_OUTPUT], via: 'fal' },
      })
    ).rejects.toThrow('organization key');
    expect(billing.settleReservation).not.toHaveBeenCalled();
  });

  it('a job with no hold succeeds uncharged and reports the skip', async () => {
    const { scopedDb, billing, gatewayJobs } = makeScopedDb();
    const charged = await settleGatewayJob({
      scopedDb,
      jobId: 'job-1',
      model: 'gpt_image_2',
      reservationId: undefined,
      costMicros: micros(1_000),
      estimateMicros: micros(1_000),
      platformFeeBps: 0,
      oauthClientId: null,
      usedOwnKey: false,
      idempotencyKey: 'k',
      result: { outputs: [IMAGE_OUTPUT], via: 'fal' },
    });
    expect(charged).toBe(0);
    expect(billing.settleReservation).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: 0 })
    );
  });
});
