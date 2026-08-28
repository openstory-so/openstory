/**
 * Tests for `StoryboardWorkflow.onFailure` (#839).
 *
 * The June 6 incident: the QStash-era log-only onFailure left ~20 sequences
 * stranded in 'processing' when await-analyze-script timed out. These tests
 * pin the rewritten hook's three branches:
 *
 *   1. Normal failure → sequence marked 'failed' with the error message and
 *      'generation.failed' emitted (failure summary + retry UI, not an
 *      eternal spinner).
 *   2. The analyze-script child already marked the sequence failed → no
 *      write, no emit — the child's specific message ("Your OpenRouter API
 *      key is invalid…") must not be clobbered by the parent's generic
 *      wrapper ("Child workflow analyze-script… failed").
 *   3. Payload without a sequenceId → no DB access at all.
 */

import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { describe, expect, test, vi } from 'vitest';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { StoryboardWorkflowInput } from '@/lib/workflow/types';

vi.doMock('@/lib/db/scoped', () => ({
  createScopedDb: vi.fn(),
}));
vi.doMock('@/lib/ai/fal-config', () => ({
  configureFalProxyFromEnv: vi.fn(),
}));
vi.doMock('@/lib/image/image-generation', () => ({
  generateImageWithProvider: vi.fn(),
}));

const emit = vi.fn();
const getGenerationChannel = vi.fn(() => ({ emit }));
vi.doMock('@/lib/realtime', () => ({ getGenerationChannel }));

const spawnAndAwaitChild = vi.fn(async () => undefined);
vi.doMock('@/lib/workflow/await-child', () => ({ spawnAndAwaitChild }));

const notifySequenceReady = vi.fn(async () => 'sent');
vi.doMock('@/lib/emails/notify-sequence-ready', () => ({
  notifySequenceReady,
  sequenceScenesUrl: (id: string) =>
    `https://openstory.so/sequences/${id}/scenes`,
}));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { StoryboardWorkflow } = await import('./storyboard-workflow');

/** Widens the protected hook so tests can invoke it directly. */
class TestableStoryboardWorkflow extends StoryboardWorkflow {
  invokeOnFailure(failure: {
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    return this.onFailure(failure);
  }

  invokeRunImpl(
    event: Readonly<WorkflowEvent<StoryboardWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<void> {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): TestableStoryboardWorkflow {
  type Ctor = ConstructorParameters<typeof TestableStoryboardWorkflow>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; onFailure never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; onFailure never reads bindings
  const env = {} as unknown as Ctor[1];
  return new TestableStoryboardWorkflow(ctx, env);
}

function makeEvent(
  sequenceId: string | undefined,
  extras: Partial<Pick<StoryboardWorkflowInput, 'notify'>> = {}
): Readonly<WorkflowEvent<StoryboardWorkflowInput>> {
  const payload: StoryboardWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    sequenceId,
    title: 'The Long Walk',
    script: 'INT. HALLWAY — NIGHT',
    aspectRatio: '16:9',
    musicPromptSource: 'ai-generated',
    styleConfig: migrateStyleConfigV1ToV2({
      mood: 'tense and hopeful',
      artStyle: 'photoreal cinematic',
      lighting: 'hard key, deep shadows',
      colorPalette: ['#101020', '#e0d0b0'],
      cameraWork: 'handheld, tight lenses',
      referenceFilms: ['Children of Men'],
      colorGrading: 'cool shadows, warm highlights',
    }),
    analysisModelId: DEFAULT_ANALYSIS_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
    videoModel: DEFAULT_VIDEO_MODEL,
    elementIds: [],
    ownerEmail: 'owner@example.com',
    sequenceUrl: 'https://openstory.so/sequences/seq_1/scenes',
    ...extras,
    options: {
      shotsPerScene: 3,
      generateThumbnails: true,
      generateDescriptions: true,
      aiProvider: 'openrouter',
      regenerateAll: true,
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowEvent stub: onFailure only reads payload
  return {
    payload,
    instanceId: 'storyboard_run_A',
    workflowName: 'storyboard',
    timestamp: new Date(0),
  };
}

function makeScopedDb(status: 'processing' | 'failed' | 'completed') {
  const updateStatus = vi.fn();
  const getForUser = vi.fn(async () => ({ id: 'seq_1', status }));
  const stub = {
    // The existence guard is a sanctioned live read (#1067).
    liveRead: { sequences: { getForUser } },
    sequence: vi.fn(() => ({ updateStatus })),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowScopedDb stub exposing only what onFailure touches
  const scopedDb = stub as unknown as WorkflowScopedDb;
  return { scopedDb, updateStatus, getForUser };
}

describe('StoryboardWorkflow.onFailure', () => {
  test('marks the sequence failed and emits generation.failed', async () => {
    emit.mockReset();
    getGenerationChannel.mockClear();
    const { scopedDb, updateStatus } = makeScopedDb('processing');

    await makeWorkflow().invokeOnFailure({
      event: makeEvent('seq_1'),
      error: 'Child workflow analyze-script timed out',
      scopedDb,
    });

    expect(updateStatus).toHaveBeenCalledWith(
      'failed',
      'Child workflow analyze-script timed out'
    );
    expect(getGenerationChannel).toHaveBeenCalledWith('seq_1');
    expect(emit).toHaveBeenCalledWith('generation.failed', {
      message: 'Child workflow analyze-script timed out',
    });
  });

  test('child already marked the sequence failed → no write, no emit', async () => {
    emit.mockReset();
    const { scopedDb, updateStatus } = makeScopedDb('failed');

    await makeWorkflow().invokeOnFailure({
      event: makeEvent('seq_1'),
      error: 'Child workflow analyze-script… failed',
      scopedDb,
    });

    expect(updateStatus).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test('missing sequenceId → no DB access', async () => {
    emit.mockReset();
    const { scopedDb, updateStatus, getForUser } = makeScopedDb('processing');

    await makeWorkflow().invokeOnFailure({
      event: makeEvent(undefined),
      error: 'boom',
      scopedDb,
    });

    expect(getForUser).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test('completed sequence is not un-completed if a trailing step fails', async () => {
    emit.mockReset();
    const { scopedDb, updateStatus } = makeScopedDb('completed');

    await makeWorkflow().invokeOnFailure({
      event: makeEvent('seq_1'),
      error: 'email-ready failed',
      scopedDb,
    });

    expect(updateStatus).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

function makeStep() {
  const names: string[] = [];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  const step = {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => {
      names.push(_name);
      return fn();
    }),
  } as unknown as WorkflowStep;
  return { step, names };
}

function makeRunImplDb() {
  const updateStatus = vi.fn();
  const deleteBySequence = vi.fn();
  const getForUser = vi.fn(async () => ({ id: 'seq_1', status: 'processing' }));
  const stub = {
    liveRead: { sequences: { getForUser } },
    sequence: vi.fn(() => ({ updateStatus })),
    shots: { deleteBySequence },
    credentials: {},
    sequences: {},
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the runImpl surface
  const scopedDb = stub as unknown as WorkflowScopedDb;
  return { scopedDb, updateStatus, names: undefined as string[] | undefined };
}

describe('StoryboardWorkflow email-ready', () => {
  test('runs the email-ready step after emit-complete', async () => {
    notifySequenceReady.mockReset();
    notifySequenceReady.mockResolvedValue('sent');
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockResolvedValue(undefined);
    emit.mockReset();

    const { scopedDb, updateStatus } = makeRunImplDb();
    const { step, names } = makeStep();

    await makeWorkflow().invokeRunImpl(makeEvent('seq_1'), step, scopedDb);

    expect(names).toEqual(
      expect.arrayContaining(['mark-completed', 'emit-complete', 'email-ready'])
    );
    expect(names.indexOf('emit-complete')).toBeGreaterThan(
      names.indexOf('mark-completed')
    );
    expect(names.indexOf('email-ready')).toBeGreaterThan(
      names.indexOf('emit-complete')
    );
    expect(updateStatus).toHaveBeenCalledWith('completed');
    expect(notifySequenceReady).toHaveBeenCalledTimes(1);
    expect(notifySequenceReady).toHaveBeenCalledWith(
      expect.objectContaining({
        sequenceId: 'seq_1',
        ownerEmail: 'owner@example.com',
        title: 'The Long Walk',
        userId: 'u1',
      })
    );
  });

  test('notify: false still runs the step; helper skips the send', async () => {
    notifySequenceReady.mockReset();
    notifySequenceReady.mockResolvedValue('skipped');
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockResolvedValue(undefined);

    const { scopedDb } = makeRunImplDb();
    const { step, names } = makeStep();

    await makeWorkflow().invokeRunImpl(
      makeEvent('seq_1', { notify: false }),
      step,
      scopedDb
    );

    expect(names).toContain('email-ready');
    expect(notifySequenceReady).toHaveBeenCalledWith(
      expect.objectContaining({ notify: false })
    );
  });
});
