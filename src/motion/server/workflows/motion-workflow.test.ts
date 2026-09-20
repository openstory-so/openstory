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
import { IMAGE_TO_VIDEO_MODELS } from '@/models/models';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { MotionWorkflowInput } from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const mockSubmit = vi.fn();
const mockPoll = vi.fn();
const mockSoften = vi.fn();
const mockDeductWorkflowCredits = vi.fn();
const mockCalculateMotionMetadata = vi.fn(() => ({ cost: 0, duration: 5 }));
const mockResolveMotionVia = vi.fn(
  async (): Promise<'fal' | 'google' | 'byteplus'> => 'fal'
);
const mockIngestArkAssets = vi.fn(
  async (_step: unknown, _args: { owner: string }) => ({})
);
const mockRecordMediaGenerationSpan = vi.fn();
const emit = vi.fn(async () => {});

vi.doMock('@/motion/server/motion-generation', () => ({
  submitMotionJob: mockSubmit,
  pollMotionJob: mockPoll,
  canRenderReferenceOnly: async () => true,
  calculateMotionMetadata: mockCalculateMotionMetadata,
  motionCostFromUsage: () => ({
    cost: 0,
    unitsBilled: 0,
    endpointId: 'fal/x',
    recordFalUsage: false,
  }),
  resolveMotionVia: mockResolveMotionVia,
  arkStillsForMotion: () => [],
}));
vi.doMock('@/models/server/byteplus-asset-steps', () => ({
  ingestArkAssets: mockIngestArkAssets,
}));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => ({}),
}));
vi.doMock('@/billing/cost-estimation', () => ({
  gateEstimate: () => 0,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeductWorkflowCredits,
  recordFalUsageStep: vi.fn(async () => ({})),
}));
vi.doMock('@/stills/server/image-compress', () => ({
  ensureImageUnderLimit: async () => null,
}));
vi.doMock('@/motion/server/video-storage', () => ({
  uploadVideoToStorage: async () => ({
    success: true,
    url: '/r2/videos/a.mp4',
    path: 'a.mp4',
  }),
  videoUrlFitsWorkflowCheckpoint: () => true,
}));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  recordProvenance: vi.fn(async () => {}),
}));
vi.doMock('@/platform/server/observability/ai-otel', () => ({
  recordMediaGenerationSpan: mockRecordMediaGenerationSpan,
}));
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: () => ({ emit }),
}));
vi.doMock('./motion-workflow-persist', () => ({
  persistMotionCompletion: async () => ({ status: 'completed' }),
  persistMotionFailure: async () => {},
}));
vi.doMock('@/stills/server/workflows/content-soften', () => ({
  MOTION_CONTENT_FALLBACK_MODEL: 'grok_imagine_video_1_5',
  softenRejectedMotionPrompt: mockSoften,
}));
// Deterministic, readable hash so the fallback step's recompute is assertable.
vi.doMock('@/shots/input-hash', () => ({
  computeVideoManifestInputHash: async (
    manifest: { motionPromptVersionId: string | null }[],
    model: string
  ) => `${model}:${manifest[0]?.motionPromptVersionId ?? 'null'}`,
}));

const mockRecordDialogue = vi.fn();
vi.doMock('@/motion/server/record-dialogue', () => ({
  recordDialogue: mockRecordDialogue,
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
  fail(
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>,
    scopedDb: WorkflowScopedDb,
    error = 'Motion generation failed: boom'
  ) {
    return this.onFailure({ event, error, scopedDb });
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

function makeScopedDb(shotAudioClips: unknown[] = []) {
  const shotPromptVersions = {
    write: vi.fn(async () => ({ id: 'spv-soft' })),
    setAudioClips: vi.fn(async () => {}),
  };
  const videoVariants = {
    appendVersion: vi.fn(async () => ({ id: 'vv-1' })),
    update: vi.fn(async () => {}),
  };
  const bytePlusAssets = {
    releaseOwner: vi.fn(async (_owner: string) => {}),
  };
  const renderSegments = {
    ensureForShot: vi.fn(async () => 'seg-1'),
    ensureForShots: vi.fn(async () => 'seg-packed'),
    setPendingPromoteVersionId: vi.fn(async () => {}),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the surface runImpl touches
  const scopedDb = {
    credentials: { resolveKey: async () => ({ source: 'platform' }) },
    liveRead: {
      shots: {
        getById: async () => ({
          id: 'shot-1',
          sceneId: 'live-scene-ulid',
          sequenceId: 'seq-1',
          renderSegmentId: null,
          audioClips: shotAudioClips,
        }),
        getByIds: async (ids: string[]) =>
          ids.map((id) => ({
            id,
            sceneId: 'live-scene-ulid',
            sequenceId: 'seq-1',
            renderSegmentId: null,
          })),
      },
      billing: { hasEnoughCredits: async () => true },
    },
    renderSegments,
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
    bytePlusAssets,
    provenance: {},
  } as unknown as WorkflowScopedDb;
  return {
    scopedDb,
    shotPromptVersions,
    videoVariants,
    bytePlusAssets,
    renderSegments,
  };
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
  mockResolveMotionVia.mockResolvedValue('fal');
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

describe('MotionWorkflow onFailure observation', () => {
  it('records the resolved via, not a hardcoded fal', async () => {
    mockResolveMotionVia.mockResolvedValueOnce('google');
    const { scopedDb } = makeScopedDb();

    await makeWorkflow().fail(
      makeEvent({ model: 'gemini_omni_flash' }),
      scopedDb
    );

    expect(mockResolveMotionVia).toHaveBeenCalledWith(
      'gemini_omni_flash',
      scopedDb.credentials
    );
    expect(mockRecordMediaGenerationSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini_omni_flash',
        provider: 'google',
        activity: 'video',
        errorType: 'provider_error',
      })
    );
  });

  it('unpins the ACR slots this run leased, by owner (#1361, #1531)', async () => {
    const { scopedDb, bytePlusAssets } = makeScopedDb();

    await makeWorkflow().fail(makeEvent(), scopedDb);

    // By run, not by still: a sibling shot polling the same sheet keeps its
    // own lease. A failed run that skipped this would hold its slots for the
    // full lease TTL.
    expect(bytePlusAssets.releaseOwner).toHaveBeenCalledWith('motion:run-1');
  });

  it('unpins on success whatever via the clip finally rendered on (#1531)', async () => {
    // An earlier attempt may have leased stills on Ark before a re-roll moved
    // the shot to another via; the success release must not be Ark-only.
    const { scopedDb, bytePlusAssets } = makeScopedDb();
    const step = makeStep();

    await makeWorkflow().runBody(makeEvent(), step, scopedDb);

    expect(step.names).toContain('release-byteplus-asset-leases');
    expect(bytePlusAssets.releaseOwner).toHaveBeenCalledWith('motion:run-1');
  });

  it('leases stills under the same owner it releases', async () => {
    mockResolveMotionVia.mockResolvedValueOnce('byteplus');
    const { scopedDb, bytePlusAssets } = makeScopedDb();

    await makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb);

    // An owner that drifted between the two would release nothing, and every
    // lease would sit out its full TTL with no error anywhere.
    const owner = mockIngestArkAssets.mock.calls[0]?.[1].owner;
    expect(owner).toBe('motion:run-1');
    expect(bytePlusAssets.releaseOwner).toHaveBeenCalledWith(owner);
  });

  it('a release that never lands does not fail a rendered clip', async () => {
    const { scopedDb, bytePlusAssets, videoVariants } = makeScopedDb();
    bytePlusAssets.releaseOwner.mockRejectedValueOnce(new Error('D1 down'));

    await makeWorkflow().runBody(makeEvent(), makeStep(), scopedDb);

    expect(videoVariants.appendVersion).toHaveBeenCalled();
  });

  it('a failed release in onFailure throws, so the emit-failure step retries it', async () => {
    const { scopedDb, bytePlusAssets } = makeScopedDb();
    bytePlusAssets.releaseOwner.mockRejectedValueOnce(new Error('D1 down'));

    await expect(makeWorkflow().fail(makeEvent(), scopedDb)).rejects.toThrow(
      'D1 down'
    );
  });
});

describe('MotionWorkflow affordability estimate (#1570)', () => {
  it('forwards the selected resolution into calculateMotionMetadata', async () => {
    const { scopedDb } = makeScopedDb();

    await makeWorkflow().runBody(
      makeEvent({ resolution: '1080p' }),
      makeStep(),
      scopedDb
    );

    expect(mockCalculateMotionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: '1080p' }),
      expect.anything()
    );
  });
});

describe('MotionWorkflow packed in-clip job (#1510)', () => {
  const motion = (text: string) => ({
    fullPrompt: text,
    dialogue: null,
    audio: null,
  });

  it('assigns covered shots to one segment using live sceneId and stamps an N-entry manifest', async () => {
    const { scopedDb, renderSegments, videoVariants } = makeScopedDb();

    await makeWorkflow().runBody(
      makeEvent({
        sceneId: 'analysis-sc-1',
        duration: 10,
        coveredShots: [
          {
            shotId: 'shot-1',
            duration: 4,
            referenceOnly: false,
            motionPromptVersionId: 'spv-1',
            frameVersionId: 'fv-1',
            motionPrompt: motion('opens the door'),
          },
          {
            shotId: 'shot-2',
            duration: 6,
            referenceOnly: false,
            motionPromptVersionId: 'spv-2',
            frameVersionId: 'fv-2',
            motionPrompt: motion('the hallway beyond'),
          },
        ],
      }),
      makeStep(),
      scopedDb
    );

    expect(renderSegments.ensureForShots).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'shot-1',
        sceneId: 'live-scene-ulid',
        sequenceId: 'seq-1',
      }),
      expect.objectContaining({
        id: 'shot-2',
        sceneId: 'live-scene-ulid',
        sequenceId: 'seq-1',
      }),
    ]);
    expect(renderSegments.ensureForShot).not.toHaveBeenCalled();
    expect(videoVariants.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        renderSegmentId: 'seg-packed',
        manifest: [
          expect.objectContaining({
            shotId: 'shot-1',
            motionPromptVersionId: 'spv-1',
            frameVersionId: 'fv-1',
            usesStartFrame: true,
            durationMs: 4000,
          }),
          expect.objectContaining({
            shotId: 'shot-2',
            motionPromptVersionId: 'spv-2',
            frameVersionId: 'fv-2',
            usesStartFrame: true,
            durationMs: 6000,
          }),
        ],
      })
    );
  });
});

describe('manifest audio key (#1671)', () => {
  it('stamps the AUTHORED lines, not the shortened wording the clip spoke', async () => {
    const { scopedDb, videoVariants } = makeScopedDb();
    const authored = {
      index: 0,
      token: 'DIALOGUE',
      voiceId: 'voice-sarah',
      text: 'Stay down, and do not move until I say so.',
      tone: '',
      ttsModel: 'eleven_v3',
      character: 'Sarah',
    };
    const authoredKey = `voice-sarah\t${authored.text}\t\televen_v3`;

    await makeWorkflow().runBody(
      makeEvent({
        voicedLines: [authored],
        audioClips: [
          {
            id: 'clip-1',
            url: '/r2/audio/clip-1.wav',
            token: 'DIALOGUE',
            durationSeconds: 3,
            sourceKey: authoredKey,
            // The #1651 rewrite shortened the take; the prompt says this,
            // the manifest must not.
            spokenLines: [{ index: 0, text: 'Stay down.' }],
          },
        ],
      }),
      makeStep(),
      scopedDb
    );

    expect(videoVariants.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: [
          expect.objectContaining({
            shotId: 'shot-1',
            audioClipIds: ['clip-1'],
            audioSourceKey: authoredKey,
          }),
        ],
      })
    );
  });
});

describe('recording its own dialogue (#1657)', () => {
  const voiced = (index: number, text: string) => ({
    index,
    token: 'DIALOGUE',
    voiceId: 'voice-sarah',
    text,
    tone: '',
    ttsModel: 'eleven_v3',
    character: 'Sarah',
  });
  const own = voiced(0, 'Now run.');
  const recordedClip = {
    id: 'section-1',
    url: '/r2/audio/section-1.wav',
    token: 'DIALOGUE',
    durationSeconds: 2,
    sourceKey: `voice-sarah\t${own.text}\t\televen_v3`,
    recordingId: 'rec-1',
  };

  it('speaks the snapshotted conversation, adopts only its own shot, and stamps the clip', async () => {
    mockRecordDialogue.mockReset();
    mockRecordDialogue.mockResolvedValue({ 'shot-1': [recordedClip] });
    const { scopedDb, videoVariants } = makeScopedDb();
    const context = [
      { ...voiced(0, 'Stay down.'), shotId: 'shot-0' },
      { ...own, shotId: 'shot-1' },
    ];

    await makeWorkflow().runBody(
      makeEvent({ voicedLines: [own], dialogueContext: context }),
      makeStep(),
      scopedDb
    );

    expect(mockRecordDialogue).toHaveBeenCalledTimes(1);
    expect(mockRecordDialogue.mock.calls[0]?.[1]).toMatchObject({
      lines: context,
      // The neighbour is spoken for the acting; its audio is not touched.
      adoptShotIds: ['shot-1'],
    });
    expect(videoVariants.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        manifest: [
          expect.objectContaining({
            audioClipIds: ['section-1'],
            audioSourceKey: recordedClip.sourceKey,
          }),
        ],
      })
    );
  });

  it('falls back to the shot’s own lines when the payload carries no context for it', async () => {
    mockRecordDialogue.mockReset();
    mockRecordDialogue.mockResolvedValue({ 'shot-1': [recordedClip] });
    const { scopedDb } = makeScopedDb();

    await makeWorkflow().runBody(
      makeEvent({
        voicedLines: [own],
        // A context that does not contain this shot is not this shot's.
        dialogueContext: [{ ...voiced(0, 'Elsewhere.'), shotId: 'shot-9' }],
      }),
      makeStep(),
      scopedDb
    );

    expect(mockRecordDialogue.mock.calls[0]?.[1]).toMatchObject({
      lines: [{ ...own, shotId: 'shot-1' }],
      adoptShotIds: ['shot-1'],
    });
  });

  it('fails instead of rendering voiced lines with no audio', async () => {
    mockRecordDialogue.mockReset();
    mockRecordDialogue.mockResolvedValue({});
    const { scopedDb } = makeScopedDb();

    await expect(
      makeWorkflow().runBody(
        makeEvent({ voicedLines: [own] }),
        makeStep(),
        scopedDb
      )
    ).rejects.toThrow(/Shot shot-1 has no audio for its lines yet/);
  });

  it("renders with the shot's own audio when nothing was promoted for it", async () => {
    // Another run held the claim for these words, or the user picked a
    // reading while this recorded: the recorder hands back nothing, and the
    // clip the shot holds NOW is the truth.
    mockRecordDialogue.mockReset();
    mockRecordDialogue.mockResolvedValue({});
    const { scopedDb, shotPromptVersions } = makeScopedDb([recordedClip]);

    await makeWorkflow().runBody(
      makeEvent({ voicedLines: [own] }),
      makeStep(),
      scopedDb
    );

    expect(shotPromptVersions.setAudioClips).toHaveBeenCalledWith(
      expect.anything(),
      [recordedClip]
    );
  });
});

describe('manifest reference keys (#1657)', () => {
  const sheet = {
    referenceImageUrl: '/r2/sheets/maya.png',
    description: 'Maya',
    role: 'character' as const,
    provenanceKey: 'character:char-1:sheet-v1',
  };
  const stampedKeys = async (model: MotionWorkflowInput['model']) => {
    const { scopedDb, videoVariants } = makeScopedDb();
    await makeWorkflow().runBody(
      makeEvent({ model, referenceImages: [sheet] }),
      makeStep(),
      scopedDb
    );
    return videoVariants.appendVersion;
  };
  const withKeys = (referenceKeys: string[]) =>
    expect.objectContaining({
      manifest: [expect.objectContaining({ referenceKeys })],
    });

  it('stamps a reference the model was sent', async () => {
    expect(await stampedKeys(MODEL)).toHaveBeenCalledWith(
      withKeys([sheet.provenanceKey])
    );
  });

  it('stamps nothing for a model with no reference slot — it only got a description', async () => {
    // A stamped key here would read Stale on the next sheet re-select and
    // sell a re-render that produces the identical clip.
    expect(await stampedKeys('grok_imagine_video_1_5')).toHaveBeenCalledWith(
      withKeys([])
    );
  });
});
