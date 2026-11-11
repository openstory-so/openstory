/**
 * GatewayGenerationWorkflow with the providers mocked: step names, the
 * settle against the job's hold, platform credentials on every provider
 * call, the via stamp the poll follows, and the release of the hold on failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { micros } from '@/billing/money';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { GatewayJobInput } from '@/gateway/schema';
import { asStub } from '@/test/as-stub';
import type { GatewayGenerationWorkflowInput } from './gateway-generation-workflow';

const mockGenerateImage = vi.fn();
const mockDeduct = vi.fn(async () => undefined);
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
  deductWorkflowCredits: mockDeduct,
  recordFalUsageStep: vi.fn(async () => ({})),
}));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  recordProvenance: vi.fn(async () => undefined),
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
    markSucceeded: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
  const bytePlusAssets = { releaseOwner: vi.fn(async () => undefined) };
  // Organization credentials throw: a gateway run must never reach them.
  const refuse = () => {
    throw new Error('organization credentials used');
  };
  const scopedDb = asStub<WorkflowScopedDb>({
    gatewayJobs,
    bytePlusAssets,
    provenance: {},
    credentials: { resolveKey: refuse, resolveOptionalKey: refuse },
  });
  return { scopedDb, gatewayJobs, bytePlusAssets };
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

describe('GatewayGenerationWorkflow image', () => {
  it('generates and stores in one step, settles against the hold, then persists', async () => {
    const step = makeStep();
    const { scopedDb, gatewayJobs } = makeScopedDb();
    const result = await makeWorkflow().runBody(
      makeEvent(IMAGE),
      step,
      scopedDb
    );

    expect(step.names).toEqual([
      'set-running',
      'generate-image',
      'settle',
      'record-provenance',
      'persist-result',
    ]);
    const credentials = mockGenerateImage.mock.calls[0]?.[1]?.credentials;
    expect(await credentials.resolveKey('fal')).toEqual({
      key: 'platform-fal',
      source: 'platform',
    });
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(12_000),
        usedOwnKey: false,
        reservationId: 'res-1',
        idempotencyKey: 'run-1:gateway-settle',
      })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith('job-1', {
      outputs: [{ url: '/r2/a.png', path: 'a.png', contentType: 'image/png' }],
      costMicros: micros(12_000),
      via: 'fal',
    });
    expect(result).toEqual({
      jobId: 'job-1',
      outputs: [{ url: '/r2/a.png', path: 'a.png', contentType: 'image/png' }],
    });
  });

  it('refuses to settle a result that used an organization key', async () => {
    mockGenerateImage.mockResolvedValueOnce({
      imageUrls: ['https://fal.media/a.png'],
      via: 'fal',
      metadata: { cost: micros(12_000), usedOwnKey: true, endpointId: 'e' },
    });
    const { scopedDb, gatewayJobs } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(IMAGE), makeStep(), scopedDb)
    ).rejects.toThrow('ran on an organization key');
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(gatewayJobs.markSucceeded).not.toHaveBeenCalled();
  });
});

describe('GatewayGenerationWorkflow video', () => {
  it('stamps the via, polls the stamped job, stores, then settles', async () => {
    const step = makeStep();
    const { scopedDb, gatewayJobs, bytePlusAssets } = makeScopedDb();
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
      'settle',
      'record-provenance',
      'persist-result',
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
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: micros(70_000),
        reservationId: 'res-1',
        usedOwnKey: false,
      })
    );
    expect(gatewayJobs.markSucceeded).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ costMicros: micros(70_000), via: 'fal' })
    );
  });

  it('fails without settling when the provider fails the job', async () => {
    mockPoll.mockResolvedValueOnce({ status: 'failed', error: 'boom' });
    const { scopedDb } = makeScopedDb();
    await expect(
      makeWorkflow().runBody(makeEvent(VIDEO), makeStep(), scopedDb)
    ).rejects.toThrow('boom');
    expect(mockDeduct).not.toHaveBeenCalled();
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
        model: 'gpt_image_2',
        reservationId: 'res-1',
        costMicros: micros(1),
        usedOwnKey: true,
        idempotencyKey: 'k',
      })
    ).rejects.toThrow('organization key');
  });
});
