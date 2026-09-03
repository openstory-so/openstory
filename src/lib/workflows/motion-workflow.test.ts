/**
 * MotionWorkflow's content-flag rescue (#1373).
 *
 * After the same-prompt reseeds exhaust, one more submit with the remedy the
 * flagged input calls for: a softened prompt when the prompt was flagged, the
 * Grok fallback when the still was, both when both. Pins the step names, which
 * prompt/model the rescue submits, what the softened version write and the
 * in-flight version update carry, the rescue emit, and the terminal message.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { MotionWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockSubmit = vi.fn();
const mockPoll = vi.fn();
const mockSoften = vi.fn();
const mockDeductWorkflowCredits = vi.fn();
const emit = vi.fn(async () => {});

vi.doMock('@/lib/motion/motion-generation', () => ({
  submitMotionJob: mockSubmit,
  pollMotionJob: mockPoll,
  canRenderReferenceOnly: async () => true,
  calculateMotionMetadata: () => ({ cost: 0, duration: 5 }),
  motionCostFromUsage: () => ({
    cost: 0,
    unitsBilled: 0,
    endpointId: 'fal/x',
    recordFalUsage: false,
  }),
}));
vi.doMock('@/lib/ai/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => ({}),
}));
vi.doMock('@/lib/billing/cost-estimation', () => ({ gateEstimate: () => 0 }));
vi.doMock('@/lib/billing/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeductWorkflowCredits,
  recordFalUsageStep: vi.fn(async () => ({})),
}));
vi.doMock('@/lib/image/image-compress', () => ({
  ensureImageUnderLimit: async () => null,
}));
vi.doMock('@/lib/motion/video-storage', () => ({
  uploadVideoToStorage: async () => ({
    success: true,
    url: '/r2/videos/a.mp4',
    path: 'a.mp4',
  }),
  videoUrlFitsWorkflowCheckpoint: () => true,
}));
vi.doMock('@/lib/compliance/provenance', () => ({
  recordProvenance: vi.fn(async () => {}),
}));
vi.doMock('@/lib/observability/ai-otel', () => ({
  recordMediaGenerationSpan: () => {},
}));
vi.doMock('@/lib/realtime', () => ({
  getGenerationChannel: () => ({ emit }),
}));
vi.doMock('@/lib/workflows/motion-workflow-persist', () => ({
  persistMotionCompletion: async () => ({ status: 'completed' }),
  persistMotionFailure: async () => {},
}));
vi.doMock('@/lib/workflows/content-soften', () => ({
  MOTION_CONTENT_FALLBACK_MODEL: 'grok_imagine_video_1_5',
  softenRejectedMotionPrompt: mockSoften,
}));
// Deterministic, readable hash so the fallback step's recompute is assertable.
vi.doMock('@/lib/ai/input-hash', () => ({
  computeVideoManifestInputHash: async (
    manifest: { motionPromptVersionId: string | null }[],
    model: string
  ) => `${model}:${manifest[0]?.motionPromptVersionId ?? 'null'}`,
}));

const { MotionWorkflow } = await import('./motion-workflow');

class Probe extends MotionWorkflow {
  runBody(
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
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
  const shotPromptVersions = {
    write: vi.fn(async () => ({ id: 'spv-soft' })),
  };
  const videoVariants = {
    appendVersion: vi.fn(async () => ({ id: 'vv-1' })),
    update: vi.fn(async () => {}),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the surface runImpl touches
  const scopedDb = {
    credentials: { resolveKey: async () => ({ source: 'platform' }) },
    liveRead: {
      shots: {
        getById: async () => ({
          id: 'shot-1',
          sceneId: 'scene-1',
          renderSegmentId: null,
        }),
      },
      billing: { hasEnoughCredits: async () => true },
    },
    renderSegments: {
      ensureForShot: async () => 'seg-1',
      setPendingPromoteVersionId: async () => {},
    },
    claims: {
      shotPromptVersions: {
        getByIdForShot: async () => ({
          inputHash: 'ctx-hash',
          analysisModel: 'anthropic/claude-haiku-4.5',
        }),
      },
    },
    shotPromptVersions,
    videoVariants,
    provenance: {},
  } as unknown as WorkflowScopedDb;
  return { scopedDb, shotPromptVersions, videoVariants };
}

const MODEL = 'seedance_v2';
const GROK = 'grok_imagine_video_1_5';
const NAME = IMAGE_TO_VIDEO_MODELS[MODEL].name;
const GROK_NAME = IMAGE_TO_VIDEO_MODELS[GROK].name;

function makeEvent(
  extra: Partial<MotionWorkflowInput> = {}
): Readonly<WorkflowEvent<MotionWorkflowInput>> {
  return {
    payload: {
      userId: 'u1',
      teamId: 'team-1',
      sequenceId: 'seq-1',
      shotId: 'shot-1',
      sceneId: 'scene-1',
      imageUrl: '/r2/stills/a.png',
      referenceOnly: false,
      prompt: 'the original prompt',
      model: MODEL,
      motionPromptVersionId: 'spv-orig',
      frameVersionId: 'fv-1',
      reservationId: 'res-1',
      duration: 5,
      ...extra,
    },
    instanceId: 'run-1',
    timestamp: new Date(),
    workflowName: 'MotionWorkflow',
  };
}

/** A fal 422 as `extractFalErrorMessage` renders it: loc-prefixed. */
const flagged = (...fields: string[]) =>
  new Error(
    fields
      .map((f) => `body.${f}: material flagged by a content checker.`)
      .join('; ')
  );
const PROMPT = flagged('prompt');
const STILL = flagged('image_url');
const BOTH = flagged('prompt', 'image_url');

const job = () => ({
  jobId: 'job-1',
  modelKey: MODEL,
  endpointId: IMAGE_TO_VIDEO_MODELS[MODEL].id,
  via: 'fal' as const,
  submittedAt: Date.now(),
  usedOwnKey: false,
});

/** Reject the three reseeds with `error`; the rescue submit then succeeds. */
function rejectReseeds(error: Error) {
  mockSubmit
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error)
    .mockRejectedValueOnce(error);
}

const submittedArgs = (call: number) =>
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- mock call args
  mockSubmit.mock.calls[call]?.[0] as { prompt: string; model: string };

const rescueEmit = () =>
  emit.mock.calls
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- mock call args
    .map((c) => (c as unknown as [string, Record<string, unknown>])[1])
    .find((p) => p.attempt === 4);

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmit.mockImplementation(async () => job());
  mockPoll.mockResolvedValue({ status: 'completed', url: 'https://fal/a.mp4' });
  mockSoften.mockResolvedValue('the softened prompt');
});

describe('MotionWorkflow content-flag rescue (#1373)', () => {
  it('prompt flagged: softens, writes a selected version, repoints the manifest, resubmits on the same model', async () => {
    rejectReseeds(PROMPT);
    const { scopedDb, shotPromptVersions, videoVariants } = makeScopedDb();
    const step = makeStep();

    const result = await makeWorkflow().runBody(makeEvent(), step, scopedDb);

    expect(result.videoUrl).toBe('/r2/videos/a.mp4');
    expect(step.names).toEqual(
      expect.arrayContaining([
        'submit-motion-retry-2',
        'load-motion-prompt-provenance',
        'write-softened-motion-prompt',
        'submit-motion-rescue',
      ])
    );
    expect(step.names).not.toContain('switch-to-fallback-video-model');
    expect(mockSubmit).toHaveBeenCalledTimes(4);
    expect(submittedArgs(3)).toMatchObject({
      prompt: 'the softened prompt',
      model: MODEL,
    });
    expect(mockSoften).toHaveBeenCalledWith(
      step,
      expect.objectContaining({
        prompt: 'the original prompt',
        rejection: PROMPT.message,
        shotId: 'shot-1',
      })
    );
    expect(shotPromptVersions.write).toHaveBeenCalledWith(
      expect.objectContaining({
        shotId: 'shot-1',
        promptType: 'motion',
        text: 'the softened prompt',
        source: 'softened',
        usesStartFrame: true,
        inputHash: 'ctx-hash',
        analysisModel: 'anthropic/claude-haiku-4.5',
        select: true,
      })
    );
    expect(videoVariants.update).toHaveBeenCalledWith('vv-1', {
      manifest: [
        expect.objectContaining({
          motionPromptVersionId: 'spv-soft',
          usesStartFrame: true,
        }),
      ],
      inputHash: `${MODEL}:spv-soft`,
    });
    expect(rescueEmit()).toMatchObject({
      attempt: 4,
      maxAttempts: 4,
      model: MODEL,
      promptSoftened: true,
      modelFallback: false,
    });
  });

  it('still flagged: no rewrite, moves the version to Grok and resubmits the original prompt there', async () => {
    rejectReseeds(STILL);
    const { scopedDb, shotPromptVersions, videoVariants } = makeScopedDb();
    const step = makeStep();

    await makeWorkflow().runBody(makeEvent(), step, scopedDb);

    expect(mockSoften).not.toHaveBeenCalled();
    expect(shotPromptVersions.write).not.toHaveBeenCalled();
    expect(step.names).toContain('switch-to-fallback-video-model');
    expect(submittedArgs(3)).toMatchObject({
      prompt: 'the original prompt',
      model: GROK,
    });
    expect(videoVariants.update).toHaveBeenCalledWith('vv-1', {
      model: GROK,
      inputHash: `${GROK}:spv-orig`,
    });
    expect(rescueEmit()).toMatchObject({
      model: GROK,
      promptSoftened: false,
      modelFallback: true,
    });
  });

  it('both flagged: softens AND swaps; the fallback hash covers the softened manifest', async () => {
    rejectReseeds(BOTH);
    const { scopedDb, videoVariants } = makeScopedDb();

    await makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb);

    expect(submittedArgs(3)).toMatchObject({
      prompt: 'the softened prompt',
      model: GROK,
    });
    expect(videoVariants.update).toHaveBeenLastCalledWith('vv-1', {
      model: GROK,
      inputHash: `${GROK}:spv-soft`,
    });
    expect(rescueEmit()).toMatchObject({
      promptSoftened: true,
      modelFallback: true,
    });
  });

  it('variant-only render appends the softened version without moving the primary selection', async () => {
    rejectReseeds(PROMPT);
    const { scopedDb, shotPromptVersions } = makeScopedDb();

    await makeWorkflow().runBody(
      makeEvent({ variantOnly: true }),
      makeStep(),
      scopedDb
    );

    expect(shotPromptVersions.write).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'softened', select: false })
    );
  });

  it('a poll-phase rejection feeds the rescue like a submit rejection', async () => {
    mockPoll
      .mockResolvedValueOnce({ status: 'failed', error: PROMPT.message })
      .mockResolvedValueOnce({ status: 'failed', error: PROMPT.message })
      .mockResolvedValueOnce({ status: 'failed', error: PROMPT.message });
    const { scopedDb } = makeScopedDb();
    const step = makeStep();

    await makeWorkflow().runBody(makeEvent(), step, scopedDb);

    expect(step.names).toContain('write-softened-motion-prompt');
    expect(submittedArgs(3)).toMatchObject({ prompt: 'the softened prompt' });
  });

  it('soften fails with only the prompt flagged: gives up naming the prompt, no 4th submit', async () => {
    mockSubmit.mockRejectedValue(PROMPT);
    mockSoften.mockRejectedValue(new Error('llm down'));
    const { scopedDb, shotPromptVersions } = makeScopedDb();
    const step = makeStep();

    await expect(
      makeWorkflow().runBody(makeEvent(), step, scopedDb)
    ).rejects.toThrow(
      `Content checker rejected the prompt (${NAME}). Rewrite the motion prompt.`
    );
    expect(mockSubmit).toHaveBeenCalledTimes(3);
    expect(step.names).not.toContain('write-softened-motion-prompt');
    expect(shotPromptVersions.write).not.toHaveBeenCalled();
  });

  it('still flagged while already on Grok: nothing left to try, three submits', async () => {
    mockSubmit.mockRejectedValue(STILL);
    const { scopedDb } = makeScopedDb();
    const step = makeStep();

    await expect(
      makeWorkflow().runBody(makeEvent({ model: GROK }), step, scopedDb)
    ).rejects.toThrow(
      `Content checker rejected the still (${GROK_NAME}). Regenerate the still.`
    );
    expect(mockSubmit).toHaveBeenCalledTimes(3);
    expect(step.names).not.toContain('switch-to-fallback-video-model');
    expect(mockSoften).not.toHaveBeenCalled();
  });

  it('rescue also rejected: the message keeps what the reseeds named even when Grok says less', async () => {
    mockSubmit
      .mockRejectedValueOnce(BOTH)
      .mockRejectedValueOnce(BOTH)
      .mockRejectedValueOnce(BOTH)
      // Native xAI shape: no `body.<field>` prefix.
      .mockRejectedValueOnce(new Error('unsafe content'));
    const { scopedDb } = makeScopedDb();

    await expect(
      makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb)
    ).rejects.toThrow(
      `Content checker rejected the still and the prompt (${NAME}, then ${GROK_NAME}; softened prompt also rejected). Regenerate the still or rewrite the motion prompt.`
    );
    expect(mockSubmit).toHaveBeenCalledTimes(4);
    expect(mockDeductWorkflowCredits).not.toHaveBeenCalled();
  });
});

describe('MotionWorkflow reference-only provenance', () => {
  it('stamps usesStartFrame: false and a null frameVersionId on the opened version', async () => {
    const { scopedDb, videoVariants } = makeScopedDb();

    await makeWorkflow().runBody(
      makeEvent({
        imageUrl: undefined,
        frameVersionId: undefined,
        referenceOnly: true,
      }),
      makeStep(),
      scopedDb
    );

    // The column default is `true`, so only an explicit `false` proves the
    // stamp was written rather than inferred.
    expect(videoVariants.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: [
          expect.objectContaining({
            usesStartFrame: false,
            frameVersionId: null,
          }),
        ],
      })
    );
  });
});
