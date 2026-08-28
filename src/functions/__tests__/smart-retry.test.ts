/**
 * Tests for `executeSmartRetry` (#839).
 *
 * Pins the orchestration the June 6 incident exposed:
 *   - the generation mutex gates EVERY retry shape — a sequence marked
 *     'failed' does not imply its workflow tree is dead, so a retry racing a
 *     live pipeline must be rejected before anything is triggered;
 *   - the full-retry fallback goes through `triggerStoryboard` (the mutex /
 *     status-write owner), never a bare trigger;
 *   - the sequence-level 'failed' flag is only cleared when something was
 *     actually retried — flipping to 'completed' after a no-op retry is the
 *     lying-status class this PR exists to kill.
 *
 * Failure *detection* lives in `analyzeFailures` (its own test file); the
 * real implementation is used here, driven by shot/sequence fixtures.
 */

import { describe, expect, test, vi } from 'vitest';
import { TEST_FAL_PRICING as FAL_PRICING } from '@/lib/ai/__tests__/fal-pricing-fixture';
import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type {
  Frame,
  FramePromptVersion,
  FrameVariant,
  Sequence,
  Shot,
  ShotPromptVersion,
  VideoVariant,
} from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  frameFixture,
  frameVariantFixture,
  videoVariantFixture,
} from '@/lib/mocks/frame-fixtures';
import { toShotView, type ShotView } from '@/lib/shots/shot-view';
import { estimateImageCost, gateEstimate } from '@/lib/billing/cost-estimation';

const assertNoActiveStoryboardMock = vi.fn();
const triggerStoryboardMock = vi.fn();
vi.doMock('@/lib/workflow/launchers', async () => {
  const real = await vi.importActual('@/lib/workflow/launchers');
  return {
    ...real,
    assertNoActiveStoryboard: assertNoActiveStoryboardMock,
    triggerStoryboard: triggerStoryboardMock,
  };
});

const triggerWorkflowMock = vi.fn();
vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: triggerWorkflowMock,
}));

const reserveRunCreditsMock = vi.fn();
vi.doMock('@/lib/billing/preflight', () => ({
  reserveRunCredits: reserveRunCreditsMock,
  releaseReservationOnThrow: async (
    _db: unknown,
    _id: unknown,
    work: () => Promise<unknown>
  ) => work(),
}));

const notifySequenceReadyMock = vi.fn();
vi.doMock('@/lib/emails/notify-sequence-ready', () => ({
  notifySequenceReady: notifySequenceReadyMock,
  sequenceScenesUrl: (id: string) =>
    `https://openstory.so/sequences/${id}/scenes`,
}));

// The live pricing loader reads D1 (unavailable under node tests).
vi.doMock('@/lib/ai/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => FAL_PRICING,
}));

// Dynamic imports so the mocks above apply (vi.doMock is not hoisted).
const { executeSmartRetry } = await import('@/lib/sequences/smart-retry');
const { GenerationInProgressError } = await import('@/lib/workflow/launchers');

const NOW = new Date('2026-06-07T00:00:00.000Z');

function makeSequence(overrides: Partial<Sequence> = {}): Sequence {
  return {
    id: 'seq_1',
    teamId: 't1',
    title: 'A sequence',
    script: 'INT. LAB — NIGHT',
    status: 'failed',
    statusError: 'Generation was interrupted',
    workflowRunId: null,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: 'u1',
    updatedBy: 'u1',
    styleId: 'style_1',
    styleConfig: null,
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
    analysisDurationMs: 0,
    imageModel: 'nano_banana_2',
    videoModel: 'kling_2_5',
    workflow: null,
    musicUrl: null,
    musicPath: null,
    // Music completed by default so tests exercise the image paths without
    // tripping the music / music-prompt retry branches.
    musicStatus: 'completed',
    musicGeneratedAt: null,
    musicError: null,
    musicModel: null,
    musicPrompt: 'ambient synths',
    musicTags: null,
    musicPromptInputHash: null,
    includeMusic: true,
    posterUrl: null,
    readyEmailSentAt: null,
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    suggestedTalentIds: null,
    suggestedLocationIds: null,
    ...overrides,
  };
}

/**
 * A shot's rows, authored as themselves: the still's lifecycle on the anchor
 * frame (#989), the still on its selected `frame_variants` row and the video
 * status on the segment's primary render (#1067). `makeContext` serves these
 * back through the scoped-DB stub, so `executeSmartRetry` assembles the same
 * `ShotView` the real read path would.
 */
type ShotFixtureOptions = Partial<Shot> & {
  imageStatus?: Frame['imageStatus'];
  imageUrl?: FrameVariant['url'];
  imagePrompt?: string | null;
  videoStatus?: VideoVariant['status'] | null;
  motionPrompt?: AssemblableMotionPrompt | null;
};

function makeShot({
  imageStatus = 'completed',
  imageUrl = 'https://cdn/thumb.jpg',
  imagePrompt = null,
  videoStatus = 'pending',
  motionPrompt = { fullPrompt: 'slow pan', dialogue: null, audio: null },
  ...overrides
}: ShotFixtureOptions = {}): ShotView {
  const shot: Shot = {
    id: 'shot-1',
    sequenceId: 'seq_1',
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  // The frame keeps its own id — distinct from the shot id (#989); only
  // `shotId` links them.
  const frameId = `frame-${shot.id}`;
  const frame: Frame = frameFixture({
    id: frameId,
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    imageStatus,
    selectedImageVersionId: imageUrl === null ? null : `${frameId}-v1`,
    selectedImagePromptVersionId: imagePrompt === null ? null : `${frameId}-ip`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return toShotView(shot, frame, {
    preview: null,
    image:
      imageUrl === null
        ? null
        : frameVariantFixture({
            id: `${frameId}-v1`,
            frameId,
            sequenceId: shot.sequenceId,
            url: imageUrl,
          }),
    imagePromptVersion:
      imagePrompt === null ? null : promptVersionFixture(frameId, imagePrompt),
    // Selection only ever points at a completed render; these fixtures drive
    // the lifecycle through the primary render instead.
    video: null,
    primaryVideo:
      videoStatus === null
        ? null
        : videoVariantFixture({
            id: `${shot.id}-primary`,
            // The degenerate one-shot segment reuses the shot's id, the same
            // idempotency key `renderSegments.ensureForShot` uses.
            renderSegmentId: shot.id,
            sequenceId: shot.sequenceId,
            status: videoStatus,
            generatedAt: null,
            manifest: [
              {
                shotId: shot.id,
                motionPromptVersionId: null,
                frameVersionId: null,
                durationMs: shot.durationMs ?? 3000,
              },
            ],
            createdAt: NOW,
            updatedAt: NOW,
          }),
    motionPrompt,
  });
}

function promptVersionFixture(
  frameId: string,
  text: string
): FramePromptVersion {
  return {
    id: `${frameId}-ip`,
    frameId,
    text,
    components: null,
    source: 'ai-generated',
    inputHash: null,
    analysisModel: null,
    status: 'completed',
    pendingInputHash: null,
    workflowRunId: null,
    createdAt: NOW,
    createdBy: null,
  };
}

function motionVersionFixture(
  shot: ShotView,
  motionPrompt: AssemblableMotionPrompt
): ShotPromptVersion {
  return {
    id: `${shot.id}-mv`,
    shotId: shot.id,
    promptType: 'motion',
    text: motionPrompt.fullPrompt,
    components: null,
    parameters: null,
    dialogue: null,
    audio: null,
    source: 'ai-generated',
    inputHash: null,
    analysisModel: null,
    status: 'completed',
    pendingInputHash: null,
    workflowRunId: null,
    createdAt: NOW,
    createdBy: null,
  };
}

/**
 * The model each shot's selected image / video version was rendered with
 * (#1066) — `shotId → model`, exactly what the scoped bulk reads return.
 */
type SelectedModels = {
  image?: Map<string, string>;
  video?: Map<string, string>;
  /** `shotId → model` of each shot's newest FAILED version (#1066). */
  failedImage?: Map<string, string>;
  failedVideo?: Map<string, string>;
};

function makeContext(
  sequence: Sequence,
  shots: ShotView[],
  selectedModels: SelectedModels = {}
) {
  const updateStatus = vi.fn();
  const updateMusicFields = vi.fn();
  const listBySequence = vi.fn(async () => shots);
  const ensureAnchorFrames = vi.fn(async () => {});
  // The source re-assembles each `ShotView` from these reads, so serve back the
  // rows the fixtures built (anchors keyed by shotId, never id-reuse).
  const listAnchorsBySequence = vi.fn(async () => shots.map((s) => s.frame));
  // The still itself is the selected `frame_variants` row (#1067).
  const getSelectedByFrameIds = vi.fn(
    async () =>
      new Map(shots.flatMap((s) => (s.image ? [[s.frame.id, s.image]] : [])))
  );
  // The image prompt resolves from the frame's selected version (#1067); the
  // backfill guarantees one exists wherever a prompt does.
  const getSelectedPromptByFrameIds = vi.fn(
    async () =>
      new Map(
        shots.flatMap((s) =>
          s.imagePromptVersion ? [[s.frame.id, s.imagePromptVersion]] : []
        )
      )
  );
  const listWithSheets = vi.fn(async () => []);
  // Model identity lives on the version that produced each asset (#1066); an
  // empty map means nothing has been rendered yet → shots inherit the sequence
  // default, preserving the legacy single-model path.
  const listSelectedImageModels = vi.fn(
    async () => selectedModels.image ?? new Map<string, string>()
  );
  const listSelectedVideoModels = vi.fn(
    async () => selectedModels.video ?? new Map<string, string>()
  );
  // The failed-attempt tier (#1066): every shot smart retry touches is in a
  // failed state, so the model that failed outranks the older selected one.
  const listFailedImageModels = vi.fn(
    async () => selectedModels.failedImage ?? new Map<string, string>()
  );
  const listFailedVideoModels = vi.fn(
    async () => selectedModels.failedVideo ?? new Map<string, string>()
  );
  // The motion prompt resolves from the shot's selected version (#713); the
  // backfill guarantees one exists wherever a prompt does.
  const motionVersionByShot = new Map(
    shots.flatMap((s) =>
      s.motionPrompt ? [[s.id, motionVersionFixture(s, s.motionPrompt)]] : []
    )
  );
  const getSelectedMotionByShots = vi.fn(
    async (shotIds: string[]) =>
      new Map(
        shotIds.flatMap((shotId) => {
          const version = motionVersionByShot.get(shotId);
          return version ? [[shotId, version] as const] : [];
        })
      )
  );
  const stub = {
    shots: { listBySequence, ensureAnchorFrames },
    frames: { listAnchorsBySequence },
    // Continuity/location context resolves through `sceneId` → `scenes` now;
    // these fixtures carry no scenes, so every shot resolves to a null scene.
    scenes: { listBySequence: vi.fn(async () => []) },
    sceneScriptVersions: {
      listSelectedBySequence: vi.fn(async () => []),
    },
    framePromptVersions: { getSelectedByFrameIds: getSelectedPromptByFrameIds },
    frameVariants: {
      listSelectedModelsBySequence: listSelectedImageModels,
      listLastFailedModelsBySequence: listFailedImageModels,
      getSelectedByFrameIds,
    },
    videoVariants: {
      listSelectedModelsBySequence: listSelectedVideoModels,
      listLastFailedModelsBySequence: listFailedVideoModels,
      // Video status derives from the segment's newest primary render (#1067).
      getSelectedByShotIds: vi.fn(async () => new Map<string, VideoVariant>()),
      getPrimaryByShotIds: vi.fn(
        async () =>
          new Map(
            shots.flatMap((s) =>
              s.primaryVideo ? [[s.id, s.primaryVideo]] : []
            )
          )
      ),
    },
    characters: { listWithSheets },
    shotPromptVersions: { getSelectedMotionByShots },
    sequence: vi.fn(() => ({ updateStatus, updateMusicFields })),
    teamManagement: {
      getMemberEmail: vi.fn(async () => 'owner@example.com'),
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub exposing only what executeSmartRetry touches
  const scopedDb = stub as unknown as ScopedDb;
  return {
    context: { sequence, user: { id: 'u1' }, teamId: 't1', scopedDb },
    scopedDb,
    updateStatus,
    listBySequence,
  };
}

function resetMocks() {
  assertNoActiveStoryboardMock.mockReset();
  assertNoActiveStoryboardMock.mockResolvedValue(undefined);
  triggerStoryboardMock.mockReset();
  triggerStoryboardMock.mockResolvedValue({ workflowRunId: 'wf_new' });
  triggerWorkflowMock.mockReset();
  triggerWorkflowMock.mockResolvedValue('wf_child');
  reserveRunCreditsMock.mockReset();
  reserveRunCreditsMock.mockResolvedValue(undefined);
  notifySequenceReadyMock.mockReset();
  notifySequenceReadyMock.mockResolvedValue('sent');
}

describe('executeSmartRetry — generation mutex (#839)', () => {
  test('live storyboard run → rejects before reading shots or triggering anything', async () => {
    resetMocks();
    assertNoActiveStoryboardMock.mockRejectedValue(
      new GenerationInProgressError()
    );
    const { context, listBySequence, updateStatus } = makeContext(
      makeSequence(),
      []
    );

    await expect(executeSmartRetry(context)).rejects.toBeInstanceOf(
      GenerationInProgressError
    );
    expect(listBySequence).not.toHaveBeenCalled();
    expect(triggerStoryboardMock).not.toHaveBeenCalled();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });
});

describe('executeSmartRetry — full retry fallback', () => {
  test('delegates to triggerStoryboard, which owns the mutex and status writes', async () => {
    resetMocks();
    // No shots + failed sequence → analyzeFailures says full retry.
    const { context, scopedDb, updateStatus } = makeContext(makeSequence(), []);

    const result = await executeSmartRetry(context);

    expect(triggerStoryboardMock).toHaveBeenCalledTimes(1);
    expect(reserveRunCreditsMock).toHaveBeenCalledTimes(1);
    expect(triggerStoryboardMock).toHaveBeenCalledWith(
      scopedDb,
      expect.objectContaining({
        sequenceId: 'seq_1',
        teamId: 't1',
        reservationId: undefined,
      })
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    // The launcher owns the 'processing' write — no direct status write here.
    expect(updateStatus).not.toHaveBeenCalled();
    expect(result).toEqual({
      retryType: 'full',
      retriedItems: ['full storyboard'],
    });
  });
});

describe('executeSmartRetry — partial retry status reset', () => {
  test('nothing retriable → throws instead of silently marking the sequence completed', async () => {
    resetMocks();
    // A failed image with no prompt anywhere (no imagePrompt, and no scene to
    // fall back to) is detected as a failure but can't be retried.
    const shot = makeShot({
      imageStatus: 'failed',
      imagePrompt: null,
    });
    const { context, updateStatus } = makeContext(makeSequence(), [shot]);

    await expect(executeSmartRetry(context)).rejects.toThrow(
      /regenerate the sequence/
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  test('retried images → triggers /image per shot and clears the failed flag', async () => {
    resetMocks();
    const shot = makeShot({
      imageStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const { context, updateStatus } = makeContext(makeSequence(), [shot]);

    const result = await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({
        shotId: 'shot-1',
        prompt: 'A cinematic shot of the lab',
        sequenceId: 'seq_1',
      }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(updateStatus).toHaveBeenCalledWith('completed');
    expect(result).toEqual({
      retryType: 'smart',
      retriedItems: ['1 image(s)'],
    });
  });

  test('mixed shots: skipped prompt-less shot is not counted as retried', async () => {
    resetMocks();
    // The counting regression #839's review flagged: reporting
    // failedImageShots.length would claim "2 image(s)" here even though
    // only one shot is actually retriable.
    const retriable = makeShot({
      id: 'shot-1',
      imageStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const skipped = makeShot({
      id: 'shot-2',
      shotNumber: 2,
      imageStatus: 'failed',
      imagePrompt: null,
    });
    const { context, updateStatus } = makeContext(makeSequence(), [
      retriable,
      skipped,
    ]);

    const result = await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-1' }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(result).toEqual({
      retryType: 'smart',
      retriedItems: ['1 image(s)'],
    });
    expect(updateStatus).toHaveBeenCalledWith('completed');
  });

  test('failed motion → triggers /motion with image url, prompt and duration', async () => {
    resetMocks();
    const shot = makeShot({
      videoStatus: 'failed',
      imageStatus: 'completed',
      imageUrl: 'https://cdn/thumb.jpg',
      motionPrompt: {
        fullPrompt: 'slow pan across the lab',
        dialogue: null,
        audio: null,
      },
      durationMs: 5000,
    });
    const { context, updateStatus } = makeContext(makeSequence(), [shot]);

    const result = await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({
        shotId: 'shot-1',
        sequenceId: 'seq_1',
        imageUrl: 'https://cdn/thumb.jpg',
        // The selected version is assembled for the target model, so the
        // stored text is carried rather than reproduced verbatim.
        prompt: expect.stringContaining('slow pan across the lab'),
        duration: 5,
      }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(result).toEqual({
      retryType: 'smart',
      retriedItems: ['1 motion video(s)'],
    });
    expect(updateStatus).toHaveBeenCalledWith('completed');
  });

  test('cancelled motion is NOT a failure — never selected for retry (#1108)', async () => {
    resetMocks();
    // Identical to the retriable failed-motion shape above except the status:
    // a deliberate user cancel must not be re-run and re-billed by Retry
    // failed. With nothing else failed, smart retry finds no work at all.
    const shot = makeShot({
      videoStatus: 'cancelled',
      imageStatus: 'completed',
      imageUrl: 'https://cdn/thumb.jpg',
      motionPrompt: {
        fullPrompt: 'slow pan across the lab',
        dialogue: null,
        audio: null,
      },
      durationMs: 5000,
    });
    const { context } = makeContext(
      makeSequence({ status: 'completed', statusError: null }),
      [shot]
    );

    await expect(executeSmartRetry(context)).rejects.toThrow();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    expect(triggerStoryboardMock).not.toHaveBeenCalled();
  });

  test('sequence not marked failed → no status write after retrying', async () => {
    resetMocks();
    const shot = makeShot({
      imageStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const { context, updateStatus } = makeContext(
      makeSequence({ status: 'completed', statusError: null }),
      [shot]
    );

    await executeSmartRetry(context);

    expect(updateStatus).not.toHaveBeenCalled();
  });

  test('no failures at all → throws', async () => {
    resetMocks();
    const { context } = makeContext(
      makeSequence({ status: 'completed', statusError: null }),
      [makeShot()]
    );

    await expect(executeSmartRetry(context)).rejects.toThrow(
      'No failures found to retry'
    );
  });
});

describe('executeSmartRetry — per-asset model selection (#1066)', () => {
  test("retries each failed image with its selected version's model, summing cost per model", async () => {
    resetMocks();
    // Two failed image shots whose selected image versions were rendered by
    // different models — both differing from the sequence default
    // ('nano_banana_2').
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      imageStatus: 'failed',
      imagePrompt: 'Look A',
    });
    const shotB = makeShot({
      id: 'shot-b',
      sceneId: 'scene-b',
      imageStatus: 'failed',
      imagePrompt: 'Look B',
    });
    const { context } = makeContext(makeSequence(), [shotA, shotB], {
      image: new Map([
        ['shot-a', 'gpt_image_2'],
        ['shot-b', 'flux_2_max'],
      ]),
    });

    await executeSmartRetry(context);

    // Each shot retries with the model that produced its current still, not
    // the sequence default.
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({
        shotId: 'shot-a',
        model: 'gpt_image_2',
        ownsReservation: true,
      }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({
        shotId: 'shot-b',
        model: 'flux_2_max',
        ownsReservation: true,
      }),
      expect.objectContaining({ label: expect.any(String) })
    );

    // One hold per shot so leftover zeros cannot kill a sibling envelope.
    const gptCost = gateEstimate(
      estimateImageCost('gpt_image_2', '16:9', 1, { pricing: FAL_PRICING }),
      {
        model: 'gpt_image_2',
        operation: 'smart-retry:image',
      }
    );
    const fluxCost = gateEstimate(
      estimateImageCost('flux_2_max', '16:9', 1, { pricing: FAL_PRICING }),
      {
        model: 'flux_2_max',
        operation: 'smart-retry:image',
      }
    );
    expect(reserveRunCreditsMock).toHaveBeenCalledTimes(2);
    expect(reserveRunCreditsMock.mock.calls[0]?.[1]).toEqual(gptCost);
    expect(reserveRunCreditsMock.mock.calls[1]?.[1]).toEqual(fluxCost);
  });

  test("retries each failed motion video with its selected version's model", async () => {
    resetMocks();
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      videoStatus: 'failed',
      imageStatus: 'completed',
      imageUrl: 'https://cdn/a.jpg',
    });
    const shotB = makeShot({
      id: 'shot-b',
      sceneId: 'scene-b',
      videoStatus: 'failed',
      imageStatus: 'completed',
      imageUrl: 'https://cdn/b.jpg',
    });
    const { context } = makeContext(makeSequence(), [shotA, shotB], {
      video: new Map([
        ['shot-a', 'seedance_v2'],
        ['shot-b', 'kling_v3_pro'],
      ]),
    });

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({
        shotId: 'shot-a',
        model: 'seedance_v2',
        ownsReservation: true,
      }),
      expect.objectContaining({ label: expect.any(String) })
    );
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({
        shotId: 'shot-b',
        model: 'kling_v3_pro',
        ownsReservation: true,
      }),
      expect.objectContaining({ label: expect.any(String) })
    );
  });

  test('retries the model that FAILED, not the older successful one', async () => {
    resetMocks();
    // shot-a's still came from gpt_image_2. The user then tried flux_2_max and
    // it failed — that failed version is not selectable, so without the
    // failed-attempt tier the retry would silently re-run gpt_image_2: the
    // model the user had already moved on from.
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      imageStatus: 'failed',
      imagePrompt: 'Look A',
    });
    const { context } = makeContext(makeSequence(), [shotA], {
      image: new Map([['shot-a', 'gpt_image_2']]),
      failedImage: new Map([['shot-a', 'flux_2_max']]),
    });

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-a', model: 'flux_2_max' }),
      expect.objectContaining({ label: expect.any(String) })
    );
    // …and it is priced as flux_2_max, so the estimate matches the charge.
    expect(reserveRunCreditsMock.mock.calls[0]?.[1]).toEqual(
      gateEstimate(
        estimateImageCost('flux_2_max', '16:9', 1, { pricing: FAL_PRICING }),
        {
          model: 'flux_2_max',
          operation: 'smart-retry:image',
        }
      )
    );
  });

  test('retries the failed video model over the older selected one', async () => {
    resetMocks();
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      videoStatus: 'failed',
      imageStatus: 'completed',
      imageUrl: 'https://cdn/a.jpg',
    });
    const { context } = makeContext(makeSequence(), [shotA], {
      video: new Map([['shot-a', 'seedance_v2']]),
      failedVideo: new Map([['shot-a', 'veo3_1']]),
    });

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({ shotId: 'shot-a', model: 'veo3_1' }),
      expect.objectContaining({ label: expect.any(String) })
    );
  });

  test('falls back to the sequence default when nothing was ever rendered', async () => {
    resetMocks();
    const shotA = makeShot({
      id: 'shot-a',
      sceneId: 'scene-a',
      imageStatus: 'failed',
      imagePrompt: 'Look A',
    });
    const { context } = makeContext(makeSequence(), [shotA]);

    await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/image',
      expect.objectContaining({ shotId: 'shot-a', model: 'nano_banana_2' }),
      expect.objectContaining({ label: expect.any(String) })
    );
  });
});
