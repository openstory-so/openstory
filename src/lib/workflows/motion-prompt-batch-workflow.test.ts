/**
 * Blast-radius test for the motion-prompt fan-out (#1143).
 *
 * The batch spawns one motion-prompt child per scene. Before this fix ANY
 * child failing threw for the whole batch, which failed motion-music-prompts →
 * analyze-script → the sequence — discarding every still that had already
 * rendered and been paid for. In the #1143 load test that meant losing 17 of
 * 18 good shots because scene 17's image tripped a content checker.
 *
 * It also stranded a sibling: the caller awaits this and the music prompt in
 * one `Promise.all`, so throwing here rejected that immediately and left the
 * still-running music child to finish into a parent already in a finite state
 * — the exact "skipping notify" shape that preceded every hang we sampled.
 *
 * The contract asserted here: partial results survive, and only a batch where
 * nothing succeeded is fatal.
 */

import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { MotionPromptBatchWorkflowInput } from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';

const spawnAndAwaitChild = vi.fn();
vi.doMock('@/lib/workflow/await-child', () => ({ spawnAndAwaitChild }));

const { MotionPromptBatchWorkflow } =
  await import('./motion-prompt-batch-workflow');

const SCENE_IDS = ['scene_1', 'scene_2', 'scene_3'];

function makeInput(): MotionPromptBatchWorkflowInput {
  const scenes = SCENE_IDS.map((sceneId, i) => ({
    sceneId,
    sceneNumber: i + 1,
    originalScript: { extract: 'a beat', lineNumber: i + 1 },
    metadata: { title: sceneId, durationSeconds: 5 },
    continuity: {},
  }));

  return {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'seq_1',
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal Scene stubs: the batch only reads sceneId when fanning out
    scenes: scenes as unknown as MotionPromptBatchWorkflowInput['scenes'],
    aspectRatio: '16:9',
    characterBible: [],
    locationBible: [],
    elementBible: [],
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl passes styleConfig straight through to the child
    styleConfig: {} as unknown as MotionPromptBatchWorkflowInput['styleConfig'],
    analysisModelId: 'anthropic/claude-sonnet-5',
    shotMapping: [],
    // Every scene has a rendered still; failures below come from the children.
    startingFrameImageUrls: Object.fromEntries(
      SCENE_IDS.map((id) => [id, `https://example.com/${id}.png`])
    ),
  };
}

function makeEvent(): Readonly<WorkflowEvent<MotionPromptBatchWorkflowInput>> {
  return {
    payload: makeInput(),
    instanceId: 'mpb_run_A',
    workflowName: 'motion-prompt-batch',
    timestamp: new Date(0),
  };
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: runImpl only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

class Probe extends MotionPromptBatchWorkflow {
  batch(
    event: Readonly<WorkflowEvent<MotionPromptBatchWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

function makeWorkflow(): Probe {
  type Ctor = ConstructorParameters<typeof Probe>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; runImpl never reads ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; only MOTION_PROMPT_WORKFLOW is read, and the spawn is mocked
  const env = {
    MOTION_PROMPT_WORKFLOW: {},
  } as unknown as Ctor[1];
  return new Probe(ctx, env);
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runImpl never touches scopedDb
const SCOPED_DB = {} as unknown as WorkflowScopedDb;

const succeed = (sceneId: string) =>
  Promise.resolve({ sceneId, motionPrompt: { fullPrompt: `move ${sceneId}` } });

describe('MotionPromptBatchWorkflow partial failures', () => {
  test('returns every prompt when all scenes succeed', async () => {
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockImplementation(
      (_step: unknown, args: { childId: string }) =>
        succeed(args.childId.split(':').at(-1) ?? '')
    );

    const result = await makeWorkflow().batch(
      makeEvent(),
      makeStep(),
      SCOPED_DB
    );

    expect(result.map((r) => r.sceneId)).toEqual(SCENE_IDS);
  });

  test('keeps the survivors when one scene fails', async () => {
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockImplementation(
      (_step: unknown, args: { childId: string }) => {
        const sceneId = args.childId.split(':').at(-1) ?? '';
        return sceneId === 'scene_2'
          ? Promise.reject(new Error('no rendered starting frame'))
          : succeed(sceneId);
      }
    );

    const result = await makeWorkflow().batch(
      makeEvent(),
      makeStep(),
      SCOPED_DB
    );

    // The whole batch used to throw here, taking the sequence with it.
    expect(result.map((r) => r.sceneId)).toEqual(['scene_1', 'scene_3']);
  });

  test('fails only when no scene produced a prompt', async () => {
    spawnAndAwaitChild.mockReset();
    spawnAndAwaitChild.mockRejectedValue(
      new Error('no rendered starting frame')
    );

    await expect(
      makeWorkflow().batch(makeEvent(), makeStep(), SCOPED_DB)
    ).rejects.toThrow(/failed for all 3 scenes/);
  });
});
