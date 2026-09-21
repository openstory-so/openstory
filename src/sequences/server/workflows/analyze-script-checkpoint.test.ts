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
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/models/models';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import { hashVisualPromptInput, sha256Hex } from '@/shots/input-hash';
import { narrowShotPromptContext } from '@/shots/server/prompt-context';
import { shotWorkItems } from '@/shots/server/shot-work-items';
import type { Scene } from '@/shots/scene-analysis.schema';
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GenerationCheckpoint } from '@/sequences/pipeline';
import { snapshotDialogueContinuation } from '../dialogue-continuation';
import type {
  CharacterMinimal,
  SequenceLocationMinimal,
} from '@/platform/server/db/schema';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  AnalyzeScriptWorkflowInput,
  SceneSplitWorkflowResult,
  MotionMusicPromptsWorkflowResult,
} from '@/platform/server/workflow/types';
import * as realCastRecords from '@/cast/server/workflows/cast-records';

vi.doMock('@/platform/server/db/scoped', () => ({ createScopedDb: vi.fn() }));
vi.doMock('@/models/server/fal-config', () => ({
  configureFalProxyFromEnv: vi.fn(),
}));
// The render gate prices the remaining work; an empty map keeps it DB-free.
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));

const createCastRecords = vi.fn(async () => ({ elements: [] }));
vi.doMock('@/cast/server/workflows/cast-records', () => ({
  ...realCastRecords,
  createCastRecords,
}));

const emit = vi.fn(async () => undefined);
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));

vi.doMock('@/cast/server/workflows/wait-for-sheets', () => ({
  waitForElementVision: vi.fn(async () => undefined),
}));

const SPLIT: SceneSplitWorkflowResult = {
  scenes: [],
  title: 'Derived',
  shotMapping: [{ analysisSceneId: 'as_1', shotId: 'sh_1', frameId: 'fr_1' }],
  characterBible: [],
  locationBible: [],
  elementBible: [],
  dialogueVersionIdByShotId: {},
};
const TALENT_MATCH = {
  characterId: 'c1',
  talentId: 'tal_1',
  talentName: 'Ada',
  personality: '',
  movement: '',
  voiceId: null,
  voiceDescription: null,
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
  voiceOnly: false,
  isPerson: true,
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
  'spawn-dialogue-audio': { clipsByShotId: { sh_1: [] } },
  'spawn-motion-batch': {},
  'spawn-shot-images': { imageUrls: [], frameVersionIds: [] },
  'spawn-motion-music-prompts': {
    completeScenes: [],
    motionPromptsBySceneId: {},
    motionPromptVersionIdsBySceneId: {},
    musicPrompt: '',
    musicTags: [],
  },
};
const defaultSpawn = async (
  _step: WorkflowStep,
  args: { spawnStepName: string; childPayload: unknown }
) => {
  const result = CHILD_RESULTS[args.spawnStepName];
  if (result === undefined) {
    throw new Error(`unexpected child ${args.spawnStepName}`);
  }
  return result;
};
const spawnAndAwaitChild = vi.fn(defaultSpawn);
vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild,
}));

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
vi.doMock('@/look/server/workflows/auto-style-step', () => ({
  deriveAutoStyle,
}));

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

const writeVisualPrompt = vi.fn(
  async (input: { frameId: string; inputHash?: string; text?: string }) => ({
    id: `fpv-${input.frameId}`,
  })
);

function makeScopedDb(update: UpdateMock): WorkflowScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub: the run stops at the script stage
  return {
    sequences: {
      update,
      updateAnalysisDurationMs: vi.fn(async () => undefined),
    },
    liveRead: { sequenceElements: { listByIds: vi.fn(async () => []) } },
    framePromptVersions: { writeAiVersion: writeVisualPrompt },
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
    referenceOnly: false,
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
    writeVisualPrompt.mockClear();
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
      makeEvent({ ...noStyle, stopAt: 'script', userCountry: 'AU' }),
      makeStep(),
      makeScopedDb(update)
    );

    expect(spawned()).toEqual([
      'spawn-scene-split',
      'spawn-talent-matching',
      'spawn-location-matching',
    ]);
    expect(childPayload('spawn-scene-split')).toMatchObject({
      userCountry: 'AU',
    });
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

  test('a failed character sheet stays at script and does not render (#1727)', async () => {
    const update: UpdateMock = vi.fn(async () => undefined);
    const bibleEntry = (characterId: string, name: string) => ({
      characterId,
      name,
      age: '',
      gender: '',
      ethnicity: '',
      physicalDescription: '',
      standardClothing: '',
      distinguishingFeatures: '',
      personality: '',
      movement: '',
      voiceDescription: '',
      voiceOnly: false,
      isPerson: true,
      consistencyTag: characterId,
    });
    const bible = [bibleEntry('c1', 'Ada'), bibleEntry('c2', 'Bob')];
    const bobFailed: CharacterMinimal = {
      ...CHARACTER_ROW,
      id: 'ch_2',
      characterId: 'c2',
      name: 'Bob',
      sheetImageUrl: null,
      sheetStatus: 'failed',
      selectedSheetVersionId: null,
    };
    spawnAndAwaitChild.mockImplementation(async (_step, args) => {
      if (args.spawnStepName === 'spawn-scene-split') {
        return { ...SPLIT, characterBible: bible };
      }
      if (args.spawnStepName === 'spawn-character-bible') {
        return [CHARACTER_ROW, bobFailed];
      }
      return defaultSpawn(_step, args);
    });

    try {
      await makeWorkflow().invokeRunImpl(
        makeEvent({ ...noStyle, stopAt: 'music' }),
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
      expect(checkpointWrite(update, 'references')).toBeUndefined();
      expect(checkpointWrite(update, 'script')).toMatchObject({
        id: 'seq_1',
        pipelineStage: 'script',
      });
    } finally {
      spawnAndAwaitChild.mockImplementation(defaultSpawn);
    }
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

  test('startFrom references: a voice-only character rides the checkpoint bible into the sheets stage (#1585)', async () => {
    const narrator = {
      characterId: 'narrator',
      name: 'Narrator',
      age: '',
      gender: '',
      ethnicity: '',
      physicalDescription: '',
      standardClothing: '',
      distinguishingFeatures: '',
      personality: 'dry, unhurried',
      movement: '',
      voiceDescription: '',
      voiceOnly: true,
      isPerson: true,
      consistencyTag: 'narrator',
    };
    const event = makeEvent({
      ...noStyle,
      startFrom: 'references',
      stopAt: 'references',
      checkpoint: {
        completedStage: 'script',
        ...SPLIT,
        characterBible: [narrator],
        talentMatches: [],
        locationMatches: [],
      },
    });

    await makeWorkflow().invokeRunImpl(
      event,
      makeStep(),
      makeScopedDb(vi.fn())
    );

    expect(childPayload('spawn-character-bible')).toMatchObject({
      characterBible: [expect.objectContaining({ voiceOnly: true })],
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

  test.each([
    { referenceOnly: false, presence: 'full' as const },
    { referenceOnly: true, presence: 'full' as const },
    { referenceOnly: false, presence: 'none' as const },
    { referenceOnly: true, presence: 'none' as const },
  ])(
    'Dialogue continuation preserves sequence music ($referenceOnly / $presence)',
    async ({ referenceOnly, presence }) => {
      const scenes: Scene[] = [5, 7].map((durationSeconds, index) => ({
        sceneId: `as_${index + 1}`,
        sceneNumber: index + 1,
        originalScript: { extract: 'A quiet moment.', dialogue: [] },
        metadata: {
          title: 'Hallway',
          durationSeconds,
          location: '',
          timeOfDay: '',
          storyBeat: '',
        },
        continuity: {
          characterTags: [],
          environmentTag: '',
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
        },
      }));
      const completeScenes = scenes.map((scene) => ({
        ...scene,
        musicDesign: {
          presence,
          style: 'ambient',
          mood: 'warm',
          atmosphere: 'quiet',
        },
      }));
      const shotMapping = scenes.map((scene, index) => ({
        analysisSceneId: scene.sceneId,
        shotId: `sh_${index + 1}`,
        frameId: `fr_${index + 1}`,
      }));
      const previousPrompts = CHILD_RESULTS['spawn-motion-music-prompts'];
      const previousVisualPrompts = CHILD_RESULTS['spawn-visual-prompts'];
      CHILD_RESULTS['spawn-visual-prompts'] = { ...VISUAL_PROMPTS, scenes };
      CHILD_RESULTS['spawn-motion-music-prompts'] = {
        completeScenes,
        motionPromptsBySceneId: {},
        musicPrompt: 'Original sequence score',
        musicTags: 'ambient',
      } satisfies MotionMusicPromptsWorkflowResult;
      let savedCheckpoint: GenerationCheckpoint | undefined;
      const saveCheckpoint = vi.fn(
        async (args: { generationCheckpoint?: GenerationCheckpoint }) => {
          if (args.generationCheckpoint)
            savedCheckpoint = args.generationCheckpoint;
        }
      );
      try {
        await makeWorkflow().invokeRunImpl(
          makeEvent({
            ...noStyle,
            referenceOnly,
            startFrom: 'references',
            stopAt: referenceOnly ? 'references' : 'images',
            checkpoint: {
              ...SPLIT,
              completedStage: 'script',
              scenes,
              shotMapping,
            },
          }),
          makeStep(),
          makeScopedDb(saveCheckpoint)
        );
      } finally {
        CHILD_RESULTS['spawn-motion-music-prompts'] = previousPrompts;
        CHILD_RESULTS['spawn-visual-prompts'] = previousVisualPrompts;
      }
      if (!savedCheckpoint) throw new Error('Missing completed checkpoint');

      // The real continue-click snapshot refreshes selections from D1. Music
      // design must survive the persisted checkpoint, without another LLM call.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only selection reads are exercised
      const selectionDb = {
        shots: {
          listBySequence: async () =>
            shotMapping.map((shot) => ({ id: shot.shotId })),
        },
        frames: {
          getAnchorsByShots: async () =>
            new Map(
              shotMapping.map((shot) => [shot.shotId, { id: shot.frameId }])
            ),
        },
        frameVariants: {
          getSelectedByFrameIds: async () =>
            new Map(
              shotMapping.map((shot) => [
                shot.frameId,
                { id: `image_${shot.frameId}`, url: '/r2/still.png' },
              ])
            ),
        },
        shotPromptVersions: {
          getSelectedMotionByShots: async () =>
            new Map(
              shotMapping.map((shot) => [
                shot.shotId,
                { id: `prompt_${shot.shotId}`, text: 'Selected motion' },
              ])
            ),
        },
      } as unknown as ScopedDb;
      savedCheckpoint = await snapshotDialogueContinuation(
        selectionDb,
        {
          id: 'seq_1',
          musicPrompt: 'Edited sequence score',
          musicTags: 'cinematic',
        },
        savedCheckpoint
      );
      spawnAndAwaitChild.mockClear();
      const update = vi.fn();
      await makeWorkflow().invokeRunImpl(
        makeEvent({
          ...noStyle,
          referenceOnly,
          startFrom: 'dialogue',
          stopAt: 'music',
          checkpoint: savedCheckpoint,
        }),
        makeStep(),
        makeScopedDb(update)
      );
      expect(spawned()).toEqual(['spawn-motion-batch']);
      expect(childPayload('spawn-motion-batch')).toMatchObject({
        includeMusic: presence !== 'none',
        music:
          presence === 'none'
            ? undefined
            : {
                prompt: 'Edited sequence score',
                tags: 'cinematic',
                duration: 12,
              },
      });
      expect(
        checkpointWrite(update, presence === 'none' ? 'motion' : 'music')
      ).toBeDefined();
    }
  );

  test.each([
    { referenceOnly: false, stopAt: 'dialogue' as const },
    { referenceOnly: true, stopAt: 'dialogue' as const },
    { referenceOnly: false, stopAt: 'music' as const },
    { referenceOnly: true, stopAt: 'music' as const },
  ])(
    'startFrom dialogue reuses selected inputs ($referenceOnly / $stopAt)',
    async ({ referenceOnly, stopAt }) => {
      const scene: Scene = {
        sceneId: 'as_1',
        sceneNumber: 1,
        originalScript: {
          extract: 'Ada speaks.',
          dialogue: [{ character: 'Ada', line: 'Old script line', tone: '' }],
        },
        metadata: {
          title: 'Hallway',
          durationSeconds: 5,
          location: '',
          timeOfDay: '',
          storyBeat: '',
        },
        continuity: {
          characterTags: [],
          environmentTag: '',
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
        },
      };
      const prompts: MotionMusicPromptsWorkflowResult = {
        completeScenes: [scene],
        motionPromptsBySceneId: {},
        motionPromptsByShotId: {
          sh_1: {
            fullPrompt: 'Preserved prompt',
            dialogue: {
              presence: true,
              lines: [
                { character: 'Ada', line: 'Edited dialogue', tone: 'warm' },
              ],
            },
            audio: { ambientSound: '', soundEffects: [] },
          },
        },
        motionPromptVersionIdsByShotId: { sh_1: 'mp_1' },
        musicPrompt: 'Preserved music',
        musicTags: 'ambient',
      };
      // A deleted sibling remains in ID-addressed asset reads and the old
      // checkpoint. Neither Dialogue nor Motion may receive it after continue.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only continuation snapshot reads are used
      const selectionDb = {
        shots: { listBySequence: async () => [{ id: 'sh_1' }] },
        frames: {
          getAnchorsByShots: async () =>
            new Map([
              ['sh_1', { id: 'fr_1' }],
              ['deleted', { id: 'fr_deleted' }],
            ]),
        },
        frameVariants: {
          getSelectedByFrameIds: async () =>
            new Map([
              ['fr_1', { id: 'fv_1', url: '/r2/still.png' }],
              ['fr_deleted', { id: 'fv_deleted', url: '/r2/deleted.png' }],
            ]),
        },
        shotPromptVersions: {
          getSelectedMotionByShots: async () =>
            new Map(
              ['sh_1', 'deleted'].map((id) => [
                id,
                {
                  id: id === 'sh_1' ? 'mp_1' : 'mp_deleted',
                  text: 'Preserved prompt',
                  dialogue: prompts.motionPromptsByShotId?.sh_1?.dialogue,
                  audio: prompts.motionPromptsByShotId?.sh_1?.audio,
                },
              ])
            ),
        },
      } as unknown as ScopedDb;
      const checkpoint = await snapshotDialogueContinuation(
        selectionDb,
        {
          id: 'seq_1',
          musicPrompt: prompts.musicPrompt,
          musicTags: prompts.musicTags,
        },
        {
          ...SPLIT,
          scenes: [scene],
          shotMapping: [
            ...SPLIT.shotMapping,
            {
              analysisSceneId: scene.sceneId,
              shotId: 'deleted',
              frameId: 'fr_deleted',
              shotNumber: 2,
            },
          ],
          completedStage: referenceOnly ? 'references' : 'images',
          charactersWithSheets: [{ ...CHARACTER_ROW, voiceId: 'voice_ada' }],
          // What `refreshCheckpointFromCast` snapshots from the shot at a continue.
          dialogueLinesByShotId: {
            sh_1: [{ character: 'Ada', line: 'Edited dialogue', tone: 'warm' }],
          },
        }
      );
      const update = vi.fn();
      const result = await makeWorkflow().invokeRunImpl(
        makeEvent({
          ...noStyle,
          referenceOnly,
          startFrom: 'dialogue',
          stopAt,
          checkpoint,
        }),
        makeStep(),
        makeScopedDb(update)
      );
      expect(result).toEqual([scene]);
      expect(spawned()).toEqual(
        stopAt === 'dialogue'
          ? ['spawn-dialogue-audio']
          : ['spawn-dialogue-audio', 'spawn-motion-batch']
      );
      if (stopAt === 'music') {
        expect(childPayload('spawn-motion-batch')).toMatchObject({
          shots: [
            {
              shotId: 'sh_1',
              motionPromptVersionId: 'mp_1',
              frameVersionId: referenceOnly ? null : 'fv_1',
              motionPrompt: { fullPrompt: 'Preserved prompt' },
            },
          ],
        });
      }
      expect(childPayload('spawn-dialogue-audio')).toMatchObject({
        scenes: [{ voiced: [{ shotId: 'sh_1', text: 'Edited dialogue' }] }],
      });
      expect(writeVisualPrompt).not.toHaveBeenCalled();
      expect(checkpointWrite(update, 'images')).toBeUndefined();
      expect(checkpointWrite(update, 'dialogue')).toMatchObject({
        generationCheckpoint: {
          completedStage: 'dialogue',
          dialogueClipsByShotId: { sh_1: [] },
        },
      });
    }
  );

  test('startFrom images: derived visual prompts stamp the verify hash, not the prompt text', async () => {
    const twoShot: Scene = {
      sceneId: 'as_1',
      sceneNumber: 1,
      originalScript: { extract: 'a beat', dialogue: [] },
      metadata: {
        title: 'Hallway',
        durationSeconds: 13,
        location: '',
        timeOfDay: '',
        storyBeat: '',
      },
      continuity: {
        characterTags: [],
        environmentTag: '',
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
      },
      shots: [
        {
          shotNumber: 1,
          framing: {
            shotSize: 'wide',
            angle: 'eye level',
            composition: '',
            subjectStartState: '',
          },
          action: 'opens the door',
          cameraMovement: { move: 'static', pacing: 'slow' },
          soundCue: '',
          dialogue: [],
          durationSeconds: 7,
        },
        {
          shotNumber: 2,
          framing: {
            shotSize: 'medium',
            angle: 'eye level',
            composition: '',
            subjectStartState: '',
          },
          action: 'cut to the hallway',
          cameraMovement: { move: 'truck', pacing: 'smooth' },
          soundCue: '',
          dialogue: [],
          durationSeconds: 6,
        },
      ],
    };
    const shotMapping = [
      {
        analysisSceneId: 'as_1',
        shotId: 'sh-1',
        frameId: 'fr-1',
        shotNumber: 1,
      },
      {
        analysisSceneId: 'as_1',
        shotId: 'sh-2',
        frameId: 'fr-2',
        shotNumber: 2,
      },
    ];
    const event = makeEvent({
      ...noStyle,
      startFrom: 'images',
      stopAt: 'images',
      checkpoint: {
        completedStage: 'references',
        ...SPLIT,
        scenes: [twoShot],
        shotMapping,
        scenesWithVisualPrompts: [twoShot],
        charactersWithSheets: [CHARACTER_ROW],
        locationsWithSheets: [LOCATION_ROW],
        allElements: [],
        visualPromptBySceneId: { as_1: 'wide shot of the hallway' },
      },
    });

    await makeWorkflow().invokeRunImpl(
      event,
      makeStep(),
      makeScopedDb(vi.fn())
    );

    const items = shotWorkItems([twoShot], shotMapping);
    expect(writeVisualPrompt).toHaveBeenCalledTimes(2);
    for (const [index, call] of writeVisualPrompt.mock.calls.entries()) {
      const item = items[index];
      const written = call[0];
      if (!item) {
        throw new Error(`missing derived visual write at ${index}`);
      }
      expect(written.frameId).toBe(item.mapping.frameId);
      const verifyHash = await hashVisualPromptInput(
        narrowShotPromptContext({
          scene: item.scene,
          styleConfig: event.payload.styleConfig,
          characterBible: SPLIT.characterBible,
          locationBible: SPLIT.locationBible,
          elementBible: SPLIT.elementBible,
          aspectRatio: event.payload.aspectRatio,
          analysisModel: event.payload.analysisModelId,
        })
      );
      const textDigest = await sha256Hex({
        kind: 'derived-shot-visual',
        shotId: item.mapping.shotId,
        text: written.text,
      });
      expect(written.inputHash).toBe(verifyHash);
      expect(written.inputHash).not.toBe(textDigest);
    }
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

  test('startFrom references without checkpoint bibles refuses before any child spawns (#1616)', async () => {
    await expect(
      makeWorkflow().invokeRunImpl(
        makeEvent({
          ...noStyle,
          startFrom: 'references',
          stopAt: 'references',
          checkpoint: {
            completedStage: 'script',
            scenes: SPLIT.scenes,
            shotMapping: SPLIT.shotMapping,
            characterBible: SPLIT.characterBible,
          },
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
