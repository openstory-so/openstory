/**
 * Step sequence and money path of StudioGenerationWorkflow (#1274).
 *
 * Pins the step names (replay dedup keys), deduct-before-upload ordering,
 * the own-key skip, the content-flag retry loop and the failure hook.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micros } from '@/lib/billing/money';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { StudioCreateInput } from '@/lib/studio/schema';
import type { StudioGenerationWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockGenerateImageWithProvider = vi.fn();
const mockDeductWorkflowCredits = vi.fn();
const mockRecordProvenance = vi.fn();
const mockSubmit = vi.fn();
const mockPoll = vi.fn();
const mockCost = vi.fn();

vi.doMock('@/lib/image/image-generation', () => ({
  generateImageWithProvider: mockGenerateImageWithProvider,
}));
vi.doMock('@/lib/billing/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeductWorkflowCredits,
  recordFalUsageStep: vi.fn(async () => ({})),
}));
vi.doMock('@/lib/compliance/provenance', () => ({
  recordProvenance: mockRecordProvenance,
}));
vi.doMock('@/lib/studio/upload', () => ({
  uploadStudioImage: vi.fn(async () => ({
    url: '/r2/thumbnails/a.png',
    path: 'a.png',
    contentType: 'image/png',
  })),
  uploadStudioVideo: vi.fn(async () => ({
    url: '/r2/videos/a.mp4',
    path: 'a.mp4',
    contentType: 'video/mp4',
  })),
}));
vi.doMock('@/lib/studio/studio-video-generation', () => ({
  submitStudioVideoJob: mockSubmit,
  pollStudioVideoJob: mockPoll,
  studioVideoCostFromUsage: mockCost,
}));

const { StudioGenerationWorkflow } =
  await import('./studio-generation-workflow');

class Probe extends StudioGenerationWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
  fail(
    event: Readonly<WorkflowEvent<StudioGenerationWorkflowInput>>,
    scopedDb: WorkflowScopedDb
  ) {
    return this.onFailure({ event, error: 'boom', scopedDb });
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never reads bindings
  const env = {} as unknown as Ctor[1];
  return new Probe(ctx, env);
}

function makeStep(): WorkflowStep & { names: string[] } {
  const names: string[] = [];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub: runImpl only uses `do` and `sleep`
  return {
    names,
    do: vi.fn((name: string, fn: () => Promise<unknown>) => {
      names.push(name);
      return fn();
    }),
    sleep: vi.fn(async () => {}),
  } as unknown as WorkflowStep & { names: string[] };
}

function makeScopedDb() {
  const generatedAssets = {
    markRunning: vi.fn(async () => {}),
    markCompleted: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the surface runImpl touches
  const scopedDb = {
    generatedAssets,
    provenance: {},
    credentials: {},
  } as unknown as WorkflowScopedDb;
  return { scopedDb, generatedAssets };
}

const IMAGE: StudioCreateInput = {
  activity: 'image',
  prompt: 'a red fox',
  imageModel: 'gpt_image_2',
  aspectRatio: '16:9',
  resolution: '720p' as const,
  count: 1,
  referenceImages: [],
};

const VIDEO: StudioCreateInput = {
  activity: 'video',
  prompt: 'the fox turns',
  videoModel: 'seedance_v2',
  aspectRatio: '16:9',
  resolution: '720p' as const,
  duration: 5,
  count: 1,
  mode: 'text',
  referenceImages: [],
  referenceVideos: [],
  referenceAudio: [],
};

function makeEvent(
  input: StudioCreateInput,
  extra: Partial<StudioGenerationWorkflowInput> = {}
): Readonly<WorkflowEvent<StudioGenerationWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 'team-1',
      assetId: 'asset-1',
      reservationId: 'res-studio-1',
      ownsReservation: true,
      input,
      ...extra,
    },
    instanceId: 'run-1',
    workflowName: 'studio',
    timestamp: new Date(0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGenerateImageWithProvider.mockResolvedValue({
    imageUrls: ['https://fal.media/a.png'],
    via: 'fal',
    metadata: { cost: micros(12_000), usedOwnKey: false, endpointId: 'e' },
  });
  mockRecordProvenance.mockResolvedValue(undefined);
  mockSubmit.mockResolvedValue({
    jobId: 'job-1',
    modelKey: 'seedance_v2',
    endpointId: 'bytedance/seedance-2.0/enterprise/v2/text-to-video',
    via: 'fal',
    usedOwnKey: false,
  });
  mockPoll.mockResolvedValue({
    status: 'completed',
    url: 'https://fal.media/a.mp4',
  });
  mockCost.mockResolvedValue({
    endpointId: 'bytedance/seedance-2.0/enterprise/v2/text-to-video',
    cost: micros(70_000),
    recordFalUsage: false,
  });
});

describe('StudioGenerationWorkflow image', () => {
  it('deducts before upload and persists last', async () => {
    const step = makeStep();
    const { scopedDb, generatedAssets } = makeScopedDb();

    await makeWorkflow().runBody(makeEvent(IMAGE), step, scopedDb);

    expect(step.names).toEqual([
      'set-running',
      'generate-image',
      'deduct-credits',
      'upload-image',
      'record-provenance',
      'persist-result',
    ]);
    expect(mockDeductWorkflowCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: 12_000,
        idempotencyKey: 'run-1:studio-image',
        reservationId: 'res-studio-1',
      })
    );
    expect(generatedAssets.markCompleted).toHaveBeenCalledWith('asset-1', {
      outputs: [{ url: '/r2/thumbnails/a.png', contentType: 'image/png' }],
      costMicros: 12_000,
    });
  });

  it('skips deduction on the team key but still records the cost', async () => {
    mockGenerateImageWithProvider.mockResolvedValue({
      imageUrls: ['https://fal.media/a.png'],
      via: 'fal',
      metadata: { cost: micros(12_000), usedOwnKey: true, endpointId: 'e' },
    });
    const step = makeStep();
    const { scopedDb, generatedAssets } = makeScopedDb();

    await makeWorkflow().runBody(makeEvent(IMAGE), step, scopedDb);

    expect(step.names).not.toContain('deduct-credits');
    expect(mockDeductWorkflowCredits).not.toHaveBeenCalled();
    expect(generatedAssets.markCompleted).toHaveBeenCalledWith(
      'asset-1',
      expect.objectContaining({ costMicros: 12_000 })
    );
  });
});

describe('StudioGenerationWorkflow video', () => {
  it('resubmits on a content flag, then bills and persists', async () => {
    mockSubmit
      .mockRejectedValueOnce(new Error('flagged by a content checker'))
      .mockRejectedValueOnce(new Error('flagged by a content checker'));
    const step = makeStep();
    const { scopedDb, generatedAssets } = makeScopedDb();

    await makeWorkflow().runBody(makeEvent(VIDEO), step, scopedDb);

    expect(step.names).toEqual([
      'set-running',
      'submit-video',
      'submit-video-retry-1',
      'submit-video-retry-2',
      'video-poll-batch-2-0',
      'price-video-generation',
      'deduct-video-credits',
      'upload-video',
      'record-provenance',
      'persist-result',
    ]);
    expect(mockDeductWorkflowCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        costMicros: 70_000,
        reservationId: 'res-studio-1',
      })
    );
    expect(generatedAssets.markCompleted).toHaveBeenCalledWith('asset-1', {
      outputs: [{ url: '/r2/videos/a.mp4', contentType: 'video/mp4' }],
      costMicros: 70_000,
    });
  });

  it('gives up after three content flags without billing', async () => {
    mockSubmit.mockRejectedValue(new Error('flagged by a content checker'));
    const { scopedDb } = makeScopedDb();

    await expect(
      makeWorkflow().runBody(makeEvent(VIDEO), makeStep(), scopedDb)
    ).rejects.toThrow(
      /^Content checker rejected the clip \(Seedance 2\.0\)\. Rewrite the prompt\. \(/
    );
    expect(mockDeductWorkflowCredits).not.toHaveBeenCalled();
  });

  it('names a flagged reference image instead of a still that does not exist (#1373)', async () => {
    mockSubmit.mockRejectedValue(
      new Error('body.image_urls.0: flagged by a content checker')
    );
    const { scopedDb } = makeScopedDb();

    await expect(
      makeWorkflow().runBody(
        makeEvent({ ...VIDEO, referenceImages: ['https://x/ref.png'] }),
        makeStep(),
        scopedDb
      )
    ).rejects.toThrow(
      'Content checker rejected a reference image (Seedance 2.0). Swap the reference image.'
    );
  });
});

describe('StudioGenerationWorkflow onFailure', () => {
  it('flips the reserved row to failed', async () => {
    const { scopedDb, generatedAssets } = makeScopedDb();
    await makeWorkflow().fail(makeEvent(IMAGE), scopedDb);
    expect(generatedAssets.markFailed).toHaveBeenCalledWith('asset-1', 'boom');
  });
});
