/**
 * Script-checkpoint durability in `AnalyzeScriptWorkflow` (#1408).
 *
 * Automatic style (#1213) is a second billed LLM call that runs alongside
 * scene-split. It used to be awaited in the same `Promise.all`, so when the
 * model answered in prose instead of JSON the rejection propagated before
 * `persist-pipeline-script` ran: the sequence kept its scenes and shots but
 * `generation_checkpoint` stayed NULL, which is exactly the state "continue
 * from the DAG" refuses with "missing script checkpoint". The only way
 * forward was paying for the split a second time.
 *
 * The contract asserted here: the split's checkpoint is persisted first, and
 * only then does the style failure fail the run.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type {
  AnalyzeScriptWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/lib/workflow/types';

vi.doMock('@/lib/db/scoped', () => ({ createScopedDb: vi.fn() }));
vi.doMock('@/lib/ai/fal-config', () => ({ configureFalProxyFromEnv: vi.fn() }));

const emit = vi.fn(async () => undefined);
vi.doMock('@/lib/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));

vi.doMock('@/lib/workflows/wait-for-sheets', () => ({
  waitForElementVision: vi.fn(async () => undefined),
}));

const SPLIT: SceneSplitWorkflowResult = {
  scenes: [],
  title: 'Derived',
  shotMapping: [{ analysisSceneId: 'as_1', shotId: 'sh_1', frameId: 'fr_1' }],
  characterBible: [],
  locationBible: [],
  elementBible: [],
};
const spawnAndAwaitChild = vi.fn(async () => SPLIT);
vi.doMock('@/lib/workflow/await-child', () => ({ spawnAndAwaitChild }));

const STYLE_FAILURE = new Error('style: structured-output-parse-failed');
const deriveAutoStyle = vi.fn(() => Promise.reject(STYLE_FAILURE));
vi.doMock('@/lib/workflows/auto-style-step', () => ({ deriveAutoStyle }));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { AnalyzeScriptWorkflow } = await import('./analyze-script-workflow');

/** Widens the protected hook so the test can drive one run directly. */
class TestableAnalyzeScriptWorkflow extends AnalyzeScriptWorkflow {
  invokeRunImpl(
    event: Readonly<WorkflowEvent<AnalyzeScriptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ) {
    return this.runImpl(event, step, scopedDb);
  }
}

/**
 * Runs every `step.do` body inline — durability is CF's job, not the test's.
 *
 * `do` is overloaded as `(name, callback)` and `(name, config, callback)`, so
 * the body is always the last argument. Typing `rest` as the union lets
 * `typeof` narrow to the callback with no assertion.
 */
function makeStep(): WorkflowStep {
  const run = (
    _name: string,
    ...rest: Array<WorkflowStepConfig | (() => Promise<unknown>)>
  ) => {
    const body = rest.at(-1);
    return typeof body === 'function'
      ? body()
      : Promise.reject(new Error('step.do called without a callback'));
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `do` is exercised
  return { do: run } as unknown as WorkflowStep;
}

type SequenceUpdate = Record<string, unknown>;
type UpdateMock = ReturnType<
  typeof vi.fn<(args: SequenceUpdate) => Promise<void>>
>;

function makeScopedDb(update: UpdateMock): WorkflowScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub: the run stops at the script stage
  return {
    sequences: {
      update,
      updateAnalysisDurationMs: vi.fn(async () => undefined),
    },
    liveRead: { sequenceElements: { listByIds: vi.fn(async () => []) } },
  } as unknown as WorkflowScopedDb;
}

function makeEvent(
  extras: Partial<AnalyzeScriptWorkflowInput> = {}
): Readonly<WorkflowEvent<AnalyzeScriptWorkflowInput>> {
  const payload: AnalyzeScriptWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'seq_1',
    script: 'INT. HALLWAY — NIGHT',
    aspectRatio: '16:9',
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
    musicPromptSource: 'ai-generated',
    // An automatic style whose recipe this run is meant to derive (#1213).
    pendingAutoStyleId: 'sty_1',
    stopAt: 'script',
    ...extras,
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowEvent stub
  return { payload, instanceId: 'analyze_run_A' } as unknown as Readonly<
    WorkflowEvent<AnalyzeScriptWorkflowInput>
  >;
}

function makeWorkflow(): TestableAnalyzeScriptWorkflow {
  type Ctor = ConstructorParameters<typeof TestableAnalyzeScriptWorkflow>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the run never reads ctx or bindings
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- child spawns are mocked, so no binding is dereferenced
  const env = {} as unknown as Ctor[1];
  return new TestableAnalyzeScriptWorkflow(ctx, env);
}

describe('AnalyzeScriptWorkflow script checkpoint', () => {
  beforeEach(() => {
    deriveAutoStyle.mockClear();
    spawnAndAwaitChild.mockClear();
  });

  test('persists the split checkpoint before a style failure fails the run', async () => {
    const update: UpdateMock = vi.fn(async () => undefined);

    await expect(
      makeWorkflow().invokeRunImpl(
        makeEvent(),
        makeStep(),
        makeScopedDb(update)
      )
    ).rejects.toThrow(STYLE_FAILURE);

    const checkpointWrite = update.mock.calls
      .map(([args]) => args)
      .find((args) => args.generationCheckpoint !== undefined);

    expect(checkpointWrite).toMatchObject({
      id: 'seq_1',
      pipelineStage: 'script',
      generationCheckpoint: {
        completedStage: 'script',
        shotMapping: SPLIT.shotMapping,
      },
    });
  });

  test('still derives the style on a continue that skips the script stage', async () => {
    // The run this resumes is precisely one whose style call failed, so it has
    // no recipe. Gating derivation on the script stage would silently render
    // every image against the placeholder (#1408).
    const event = makeEvent({
      startFrom: 'casting',
      stopAt: 'casting',
      checkpoint: { completedStage: 'script', ...SPLIT },
    });

    await expect(
      makeWorkflow().invokeRunImpl(event, makeStep(), makeScopedDb(vi.fn()))
    ).rejects.toThrow(STYLE_FAILURE);

    expect(deriveAutoStyle).toHaveBeenCalledTimes(1);
    expect(spawnAndAwaitChild).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ spawnStepName: 'spawn-scene-split' })
    );
  });
});
