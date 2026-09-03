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
 *
 * Also pinned: which children each stop-at spawns, what each stage writes
 * to `generation_checkpoint`, and that a continue reads the bible and sheet
 * rows off the checkpoint instead of re-running the stages that made them.
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
  CharacterMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  AnalyzeScriptWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/lib/workflow/types';
import * as realCastRecords from '@/lib/workflows/cast-records';

vi.doMock('@/lib/db/scoped', () => ({ createScopedDb: vi.fn() }));
vi.doMock('@/lib/ai/fal-config', () => ({ configureFalProxyFromEnv: vi.fn() }));
// The render gate prices the remaining work; an empty map keeps it DB-free.
vi.doMock('@/lib/ai/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));

const createCastRecords = vi.fn(async () => ({ elements: [] }));
vi.doMock('@/lib/workflows/cast-records', () => ({
  ...realCastRecords,
  createCastRecords,
}));

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
const TALENT_MATCH = {
  characterId: 'c1',
  talentId: 'tal_1',
  talentName: 'Ada',
  sheetImageUrl: '/r2/ada.png',
};
const LOCATION_MATCH = {
  locationId: 'l1',
  libraryLocationId: 'lib_1',
  libraryLocationName: 'Hallway',
  referenceImageUrl: '/r2/hall.png',
};
const CHARACTER_ROW: CharacterMinimal = {
  id: 'ch_1',
  characterId: 'c1',
  name: 'Ada',
  sheetImageUrl: '/r2/ada-sheet.png',
  sheetStatus: 'completed',
  sheetInputHash: 'hash_ada',
  selectedSheetVersionId: 'csv_1',
  physicalDescription: 'tall',
  consistencyTag: 'ADA',
};
const LOCATION_ROW: SequenceLocationMinimal = {
  id: 'loc_1',
  locationId: 'l1',
  name: 'Hallway',
  referenceImageUrl: '/r2/hall-sheet.png',
  referenceStatus: 'completed',
  referenceInputHash: 'hash_hall',
  selectedReferenceVersionId: 'lrv_1',
  description: 'dim corridor',
  consistencyTag: 'HALL',
};
const VISUAL_PROMPTS = {
  scenes: [],
  visualPromptsBySceneId: { as_1: { fullPrompt: 'wide shot of the hallway' } },
};

/** One plausible result per child, keyed by its spawn step. */
const CHILD_RESULTS: Record<string, unknown> = {
  'spawn-scene-split': SPLIT,
  'spawn-talent-matching': { matches: [TALENT_MATCH] },
  'spawn-location-matching': { matches: [LOCATION_MATCH] },
  'spawn-character-bible': [CHARACTER_ROW],
  'spawn-location-bible': [LOCATION_ROW],
  'spawn-visual-prompts': VISUAL_PROMPTS,
  'spawn-shot-images': { imageUrls: [], frameVersionIds: [] },
  'spawn-motion-music-prompts': {
    completeScenes: [],
    motionPromptsBySceneId: {},
    motionPromptVersionIdsBySceneId: {},
    musicPrompt: '',
    musicTags: [],
  },
};
const spawnAndAwaitChild = vi.fn(
  async (
    _step: WorkflowStep,
    args: { spawnStepName: string; childPayload: unknown }
  ) => {
    const result = CHILD_RESULTS[args.spawnStepName];
    if (result === undefined) {
      throw new Error(`unexpected child ${args.spawnStepName}`);
    }
    return result;
  }
);
vi.doMock('@/lib/workflow/await-child', () => ({ spawnAndAwaitChild }));

const spawned = () =>
  spawnAndAwaitChild.mock.calls.map(([, args]) => args.spawnStepName);
const childPayload = (spawnStepName: string) =>
  spawnAndAwaitChild.mock.calls.find(
    ([, args]) => args.spawnStepName === spawnStepName
  )?.[1].childPayload;
const checkpointWrite = (update: UpdateMock, stage: string) =>
  update.mock.calls
    .map(([args]) => args)
    .filter((args) => args.pipelineStage === stage)
    .at(-1);

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
    createCastRecords.mockClear();
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
      startFrom: 'references',
      stopAt: 'references',
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

  // The runs below have no automatic style, so a stage's own work is what
  // ends them — not the style rejection the tests above lean on.
  const noStyle = { pendingAutoStyleId: undefined } as const;

  test('stopAt script: casts, checkpoints the matches, spawns nothing further', async () => {
    const update: UpdateMock = vi.fn(async () => undefined);

    await makeWorkflow().invokeRunImpl(
      makeEvent({ ...noStyle, stopAt: 'script' }),
      makeStep(),
      makeScopedDb(update)
    );

    expect(spawned()).toEqual([
      'spawn-scene-split',
      'spawn-talent-matching',
      'spawn-location-matching',
    ]);
    expect(createCastRecords).toHaveBeenCalledTimes(1);
    expect(checkpointWrite(update, 'script')).toMatchObject({
      id: 'seq_1',
      generationCheckpoint: {
        completedStage: 'script',
        shotMapping: SPLIT.shotMapping,
        talentMatches: [TALENT_MATCH],
        locationMatches: [LOCATION_MATCH],
      },
    });
  });

  test('stopAt references: spawns the sheets + prompts, checkpoints them, renders nothing', async () => {
    const update: UpdateMock = vi.fn(async () => undefined);

    await makeWorkflow().invokeRunImpl(
      makeEvent({ ...noStyle, stopAt: 'references' }),
      makeStep(),
      makeScopedDb(update)
    );

    expect(spawned()).toEqual(
      expect.arrayContaining([
        'spawn-character-bible',
        'spawn-location-bible',
        'spawn-visual-prompts',
      ])
    );
    expect(spawned()).not.toContain('spawn-shot-images');
    expect(checkpointWrite(update, 'references')).toMatchObject({
      id: 'seq_1',
      generationCheckpoint: {
        completedStage: 'references',
        charactersWithSheets: [CHARACTER_ROW],
        locationsWithSheets: [LOCATION_ROW],
        allElements: [],
        visualPromptBySceneId: { as_1: 'wide shot of the hallway' },
        scenesWithVisualPrompts: VISUAL_PROMPTS.scenes,
      },
    });
  });

  test('startFrom references: skips the script stage and reads the bible off the checkpoint', async () => {
    const event = makeEvent({
      ...noStyle,
      startFrom: 'references',
      stopAt: 'references',
      checkpoint: {
        completedStage: 'script',
        ...SPLIT,
        talentMatches: [TALENT_MATCH],
        locationMatches: [LOCATION_MATCH],
      },
    });

    await makeWorkflow().invokeRunImpl(
      event,
      makeStep(),
      makeScopedDb(vi.fn())
    );

    expect(spawned()).not.toEqual(
      expect.arrayContaining([
        'spawn-scene-split',
        'spawn-talent-matching',
        'spawn-location-matching',
      ])
    );
    expect(createCastRecords).not.toHaveBeenCalled();
    expect(spawned()).toEqual(
      expect.arrayContaining(['spawn-character-bible', 'spawn-location-bible'])
    );
    expect(childPayload('spawn-character-bible')).toMatchObject({
      characterBible: SPLIT.characterBible,
      talentMatches: [TALENT_MATCH],
    });
    expect(childPayload('spawn-location-bible')).toMatchObject({
      locationBible: SPLIT.locationBible,
      libraryLocationMatches: [LOCATION_MATCH],
    });
  });

  test('startFrom images: renders against the checkpoint sheet rows verbatim', async () => {
    const event = makeEvent({
      ...noStyle,
      startFrom: 'images',
      stopAt: 'images',
      checkpoint: {
        completedStage: 'references',
        ...SPLIT,
        charactersWithSheets: [CHARACTER_ROW],
        locationsWithSheets: [LOCATION_ROW],
        allElements: [],
        visualPromptBySceneId: { as_1: 'wide shot of the hallway' },
        scenesWithVisualPrompts: [],
      },
    });

    await makeWorkflow().invokeRunImpl(
      event,
      makeStep(),
      makeScopedDb(vi.fn())
    );

    expect(spawned()).toEqual([
      'spawn-shot-images',
      'spawn-motion-music-prompts',
    ]);
    // Pins that a continue renders against the checkpoint rows — including
    // the version ids and input hashes the still's manifest hashes against.
    expect(childPayload('spawn-shot-images')).toMatchObject({
      charactersWithSheets: [CHARACTER_ROW],
      locationsWithSheets: [LOCATION_ROW],
    });
  });

  test('startFrom references without a checkpoint refuses before any child spawns', async () => {
    await expect(
      makeWorkflow().invokeRunImpl(
        makeEvent({
          ...noStyle,
          startFrom: 'references',
          stopAt: 'references',
        }),
        makeStep(),
        makeScopedDb(vi.fn())
      )
    ).rejects.toThrow(
      new WorkflowValidationError(
        'Cannot continue generation: missing script checkpoint'
      )
    );

    expect(spawnAndAwaitChild).not.toHaveBeenCalled();
  });
});
