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
 * real implementation is used here, driven by frame/sequence fixtures.
 */

import { describe, expect, test, vi } from 'vitest';
import type { Shot, Sequence } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';

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

const requireCreditsMock = vi.fn();
vi.doMock('@/lib/billing/preflight', () => ({
  requireCredits: requireCreditsMock,
}));

// Dynamic imports so the mocks above apply (vi.doMock is not hoisted).
const { executeSmartRetry } = await import('../smart-retry');
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
    autoGenerateMotion: false,
    autoGenerateMusic: false,
    suggestedTalentIds: null,
    suggestedLocationIds: null,
    ...overrides,
  };
}

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: 'seq_1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: 'A scene',
    durationMs: 3000,
    thumbnailUrl: 'https://cdn/thumb.jpg',
    thumbnailPath: null,
    thumbnailStatus: 'completed',
    thumbnailWorkflowRunId: null,
    thumbnailGeneratedAt: null,
    thumbnailError: null,
    imageModel: 'nano_banana_2',
    imagePrompt: null,
    variantImageUrl: null,
    variantImageStatus: 'pending',
    variantWorkflowRunId: null,
    variantImageGeneratedAt: null,
    variantImageError: null,
    videoUrl: null,
    videoPath: null,
    videoStatus: 'pending',
    videoWorkflowRunId: null,
    videoGeneratedAt: null,
    videoError: null,
    motionPrompt: 'slow pan',
    motionModel: null,
    audioUrl: null,
    audioPath: null,
    audioStatus: 'pending',
    audioWorkflowRunId: null,
    audioGeneratedAt: null,
    audioError: null,
    audioModel: null,
    thumbnailInputHash: null,
    variantImageInputHash: null,
    videoInputHash: null,
    audioInputHash: null,
    visualPromptInputHash: null,
    motionPromptInputHash: null,
    previewThumbnailUrl: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeContext(sequence: Sequence, frames: Shot[]) {
  const updateStatus = vi.fn();
  const updateMusicFields = vi.fn();
  const listBySequence = vi.fn(async () => frames);
  const listWithSheets = vi.fn(async () => []);
  const stub = {
    shots: { listBySequence },
    // No scene overrides in these tests → frames inherit the sequence model
    // (#909 scene-level resolution falls back to the sequence default).
    scenes: { listBySequence: vi.fn(async () => []) },
    characters: { listWithSheets },
    sequence: vi.fn(() => ({ updateStatus, updateMusicFields })),
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
  requireCreditsMock.mockReset();
  requireCreditsMock.mockResolvedValue(undefined);
}

describe('executeSmartRetry — generation mutex (#839)', () => {
  test('live storyboard run → rejects before reading frames or triggering anything', async () => {
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
    // No frames + failed sequence → analyzeFailures says full retry.
    const { context, scopedDb, updateStatus } = makeContext(makeSequence(), []);

    const result = await executeSmartRetry(context);

    expect(triggerStoryboardMock).toHaveBeenCalledTimes(1);
    expect(triggerStoryboardMock).toHaveBeenCalledWith(
      scopedDb,
      expect.objectContaining({ sequenceId: 'seq_1', teamId: 't1' })
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
    // A failed image with no prompt anywhere (imagePrompt, metadata,
    // description all empty) is detected as a failure but can't be retried.
    const frame = makeShot({
      thumbnailStatus: 'failed',
      imagePrompt: null,
      metadata: null,
      description: '',
    });
    const { context, updateStatus } = makeContext(makeSequence(), [frame]);

    await expect(executeSmartRetry(context)).rejects.toThrow(
      /regenerate the sequence/
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  test('retried images → triggers /image per frame and clears the failed flag', async () => {
    resetMocks();
    const frame = makeShot({
      thumbnailStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const { context, updateStatus } = makeContext(makeSequence(), [frame]);

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

  test('mixed frames: skipped prompt-less frame is not counted as retried', async () => {
    resetMocks();
    // The counting regression #839's review flagged: reporting
    // failedImageFrames.length would claim "2 image(s)" here even though
    // only one frame is actually retriable.
    const retriable = makeShot({
      id: 'shot-1',
      thumbnailStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const skipped = makeShot({
      id: 'shot-2',
      orderIndex: 1,
      thumbnailStatus: 'failed',
      imagePrompt: null,
      metadata: null,
      description: '',
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
    const frame = makeShot({
      videoStatus: 'failed',
      thumbnailStatus: 'completed',
      thumbnailUrl: 'https://cdn/thumb.jpg',
      motionPrompt: 'slow pan across the lab',
      durationMs: 5000,
    });
    const { context, updateStatus } = makeContext(makeSequence(), [frame]);

    const result = await executeSmartRetry(context);

    expect(triggerWorkflowMock).toHaveBeenCalledTimes(1);
    expect(triggerWorkflowMock).toHaveBeenCalledWith(
      '/motion',
      expect.objectContaining({
        shotId: 'shot-1',
        sequenceId: 'seq_1',
        imageUrl: 'https://cdn/thumb.jpg',
        prompt: 'slow pan across the lab',
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

  test('sequence not marked failed → no status write after retrying', async () => {
    resetMocks();
    const frame = makeShot({
      thumbnailStatus: 'failed',
      imagePrompt: 'A cinematic shot of the lab',
    });
    const { context, updateStatus } = makeContext(
      makeSequence({ status: 'completed', statusError: null }),
      [frame]
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
