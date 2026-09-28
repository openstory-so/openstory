/**
 * A continue runs the generation plan's units through the Update-all
 * executor (#1818). These pin the references wave: only the owed sheets,
 * element references and voices are spawned — each behind its claim — and a
 * reference that fails holds the stills made from it, and nothing else.
 */

import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStaleShotsWorkflowInput } from '@/platform/server/workflow/types';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import { ZERO_MICROS } from '@/billing/money';
import {
  characterSheetInputHash,
  locationSheetInputHash,
} from '@/shots/input-hash';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';
import type { PlanReferences } from '../update-stale-references';
import type { PlanTarget, UpdateStalePlan } from '../update-stale-plan';
import * as realPlan from '../update-stale-plan';

const emit = vi.fn(async () => undefined);
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
}));
vi.doMock('@/platform/server/db/scoped', () => ({ createScopedDb: vi.fn() }));
vi.doMock('@/shots/server/scene-script', () => ({
  loadSceneContextBySequence: vi.fn(async () => new Map()),
  resolveSceneForShot: vi.fn(() => ({ scene: null, script: null })),
}));
vi.doMock('@/shots/server/shot-image-input', () => ({
  prepareShotImageWorkflowInput: vi.fn(async () => ({ prompt: 'p' })),
}));
vi.doMock('../update-stale-plan', () => ({
  ...realPlan,
  claimTargets: vi.fn(async ({ targets }: { targets: PlanTarget[] }) => ({
    claimsByShot: Object.fromEntries(
      targets.map((t) => [
        t.shotId,
        {
          visualVersionId: null,
          motionVersionId: null,
          imageVariantId: `claim-${t.shotId}`,
        },
      ])
    ),
    skipped: [],
  })),
}));

const failCharacter = new Set<string>();
const spawnAndAwaitChild = vi.fn(
  async (
    _step: WorkflowStep,
    args: { spawnStepName: string; childPayload: unknown }
  ) => {
    for (const id of failCharacter) {
      if (args.spawnStepName === `spawn-character-sheet-${id}`) {
        throw new Error('sheet model refused');
      }
    }
    if (args.spawnStepName.startsWith('spawn-image-')) {
      return { imageUrl: 'https://x/still.png' };
    }
    return {};
  }
);
vi.doMock('@/platform/server/workflow/await-child', () => ({
  spawnAndAwaitChild,
}));

const { UpdateStaleShotsWorkflow } =
  await import('./update-stale-shots-workflow');

type RunDb = Parameters<
  InstanceType<typeof UpdateStaleShotsWorkflow>['runImpl']
>[2];

class Testable extends UpdateStaleShotsWorkflow {
  invoke(event: Readonly<WorkflowEvent<UpdateStaleShotsWorkflowInput>>) {
    return this.runImpl(event, makeStep(), makeScopedDb());
  }
}

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

const claimSheet = vi.fn<RunDb['characters']['claimSheet']>(
  async (id) => `csv-${id}`
);
const failSheetClaim = vi.fn<RunDb['characters']['failSheetClaim']>(
  async () => undefined
);
const claimReference = vi.fn<RunDb['sequenceLocations']['claimReference']>(
  async (id) => `lrv-${id}`
);
const createPendingVoiceClaim = vi.fn<
  RunDb['characters']['createPendingVoiceClaim']
>(async (id) => ({
  created: true,
  version: { id: `husk-${id}`, workflowRunId: null },
}));

function idle<M extends (...args: never[]) => unknown>(): M {
  return vi.fn<M>();
}

function makeScopedDb(): RunDb {
  const listed = {
    characters: {
      listWithSheets: idle<RunDb['liveRead']['characters']['listWithSheets']>(),
    },
    sequenceLocations: {
      listWithReferences:
        idle<RunDb['liveRead']['sequenceLocations']['listWithReferences']>(),
    },
    sequenceElements: {
      list: idle<RunDb['liveRead']['sequenceElements']['list']>(),
    },
  };
  return {
    characters: {
      claimSheet,
      failSheetClaim,
      createPendingVoiceClaim,
      markVoiceClaimTerminal:
        idle<RunDb['characters']['markVoiceClaimTerminal']>(),
    },
    sequenceLocations: {
      claimReference,
      failReferenceClaim:
        idle<RunDb['sequenceLocations']['failReferenceClaim']>(),
    },
    frameVariants: {
      markTerminal: idle<RunDb['frameVariants']['markTerminal']>(),
      cancelByDependency: idle<RunDb['frameVariants']['cancelByDependency']>(),
    },
    framePromptVersions: {
      markTerminal: idle<RunDb['framePromptVersions']['markTerminal']>(),
    },
    shotPromptVersions: {
      markTerminal: idle<RunDb['shotPromptVersions']['markTerminal']>(),
    },
    stalenessPlanning: {
      framePromptVersions: {
        getLivePending:
          idle<
            RunDb['stalenessPlanning']['framePromptVersions']['getLivePending']
          >(),
        createPending:
          idle<
            RunDb['stalenessPlanning']['framePromptVersions']['createPending']
          >(),
        getSelected:
          idle<
            RunDb['stalenessPlanning']['framePromptVersions']['getSelected']
          >(),
        write:
          idle<RunDb['stalenessPlanning']['framePromptVersions']['write']>(),
      },
      shotPromptVersions: {
        getLivePending:
          idle<
            RunDb['stalenessPlanning']['shotPromptVersions']['getLivePending']
          >(),
        createPending:
          idle<
            RunDb['stalenessPlanning']['shotPromptVersions']['createPending']
          >(),
      },
      frameVariants: {
        listLiveClaims:
          idle<RunDb['stalenessPlanning']['frameVariants']['listLiveClaims']>(),
        createPendingClaim:
          idle<
            RunDb['stalenessPlanning']['frameVariants']['createPendingClaim']
          >(),
        getSelected:
          idle<RunDb['stalenessPlanning']['frameVariants']['getSelected']>(),
        getLastFailed:
          idle<RunDb['stalenessPlanning']['frameVariants']['getLastFailed']>(),
      },
      scenes: {
        listBySequence:
          idle<RunDb['stalenessPlanning']['scenes']['listBySequence']>(),
      },
      sceneScriptVersions: {
        listSelectedBySequence:
          idle<
            RunDb['stalenessPlanning']['sceneScriptVersions']['listSelectedBySequence']
          >(),
      },
      characters: listed.characters,
      sequenceLocations: listed.sequenceLocations,
      sequenceElements: listed.sequenceElements,
      styles: {
        getById: idle<RunDb['stalenessPlanning']['styles']['getById']>(),
      },
      apiKeys: {
        hasUsableKey:
          idle<RunDb['stalenessPlanning']['apiKeys']['hasUsableKey']>(),
      },
      billing: {
        hasEnoughCredits:
          idle<RunDb['stalenessPlanning']['billing']['hasEnoughCredits']>(),
      },
    },
    liveRead: {
      apiKeys: {
        hasUsableKey: vi.fn<RunDb['liveRead']['apiKeys']['hasUsableKey']>(
          async () => false
        ),
      },
      billing: {
        hasEnoughCredits: vi.fn<
          RunDb['liveRead']['billing']['hasEnoughCredits']
        >(async () => true),
      },
      characters: listed.characters,
      sequenceLocations: listed.sequenceLocations,
      sequenceElements: listed.sequenceElements,
      shots: {
        getById: vi.fn<RunDb['liveRead']['shots']['getById']>(async (id) => ({
          id,
          sceneId: null,
          durationMs: null,
          shotNumber: null,
          renderSegmentId: null,
          audioClips: null,
        })),
      },
      frames: {
        getAnchorByShot: vi.fn<RunDb['liveRead']['frames']['getAnchorByShot']>(
          async (id) => ({ id: `f-${id}` })
        ),
      },
      frameVariants: {
        getSelected: idle<RunDb['liveRead']['frameVariants']['getSelected']>(),
      },
      videoVariants: {
        getSelectedByShot:
          idle<RunDb['liveRead']['videoVariants']['getSelectedByShot']>(),
        listBySegment:
          idle<RunDb['liveRead']['videoVariants']['listBySegment']>(),
      },
      sequences: {
        getById: idle<RunDb['liveRead']['sequences']['getById']>(),
      },
    },
    claims: {
      framePromptVersions: {
        getByIdForFrame:
          idle<RunDb['claims']['framePromptVersions']['getByIdForFrame']>(),
      },
      frameVariants: {
        getById: idle<RunDb['claims']['frameVariants']['getById']>(),
      },
      shotPromptVersions: {
        getByIdForShot:
          idle<RunDb['claims']['shotPromptVersions']['getByIdForShot']>(),
      },
    },
  };
}

function target(shotId: string, referenceIds: string[]): PlanTarget {
  return {
    shotId,
    frameId: `f-${shotId}`,
    beforeShotId: null,
    afterShotId: null,
    startingFrameImageUrl: null,
    usesStartFrame: true,
    durationMs: null,
    standingImageVariantId: null,
    standingMotionVersionId: null,
    visualPromptVersionId: null,
    regenVisual: false,
    regenMotion: false,
    regenImage: true,
    visualLiveHash: null,
    motionLiveHash: null,
    imageLiveHash: 'ih',
    imageModel: 'nano_banana_2',
    regenVideo: false,
    createsVideo: false,
    staleVideoVersionId: null,
    referenceIds,
    attachSceneHeader: false,
    regenDialogue: false,
    dialogue: { presence: false, lines: [] },
    dialogueContext: [],
  };
}

function plan(overrides: Partial<UpdateStalePlan>): UpdateStalePlan {
  const sequence: UpdateStalePlan['sequence'] = {
    id: 'seq-1',
    teamId: 't1',
    title: 'S',
    aspectRatio: '16:9',
    resolution: '1080p',
    imageModel: 'nano_banana_2',
    videoModel: 'kling_v3_pro',
    styleId: null,
    analysisModel: 'x',
    generateStartFrames: true,
    draftMotion: false,
  };
  const promptContext: NonNullable<UpdateStalePlan['promptContext']> = {
    characterBible: [],
    locationBible: [],
    elementBible: [],
    styleConfig: {
      version: 2,
      look: {
        mood: 'tense',
        artStyle: 'photo',
        lighting: 'hard',
        colorPalette: ['#111111'],
        colorGrading: 'cool',
      },
      motion: { camera: 'handheld' },
      references: [],
    },
    analysisModelId: DEFAULT_ANALYSIS_MODEL,
  };
  return {
    aspectRatio: overrides.aspectRatio ?? '16:9',
    resolution: overrides.resolution ?? '1080p',
    sequence: overrides.sequence ?? sequence,
    music: overrides.music === undefined ? null : overrides.music,
    promptContext:
      overrides.promptContext === undefined
        ? promptContext
        : overrides.promptContext,
    characterVoices: overrides.characterVoices ?? [],
    dialogueRecording:
      overrides.dialogueRecording === undefined
        ? null
        : overrides.dialogueRecording,
    targets: overrides.targets ?? [],
    skipped: overrides.skipped ?? [],
    references:
      overrides.references === undefined ? null : overrides.references,
  };
}

const run = (p: UpdateStalePlan) =>
  new Testable(
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- ctx is never read
    undefined as unknown as ConstructorParameters<typeof Testable>[0],
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- children are mocked, no binding is dereferenced
    {} as unknown as ConstructorParameters<typeof Testable>[1]
  ).invoke({
    payload: {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq-1',
      plan: p,
      announcePhases: true,
    },
    timestamp: new Date(0),
    instanceId: 'run-1',
    workflowName: 'UPDATE_STALE_SHOTS_WORKFLOW',
  });

const spawned = () =>
  spawnAndAwaitChild.mock.calls.map(([, args]) => args.spawnStepName);
const payloadOf = (step: string) =>
  spawnAndAwaitChild.mock.calls.find(([, a]) => a.spawnStepName === step)?.[1]
    .childPayload;

function characterBible(id: string, name: string): CharacterBibleEntry {
  return {
    characterId: id,
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
    consistencyTag: id,
  };
}

function locationBible(id: string, name: string): LocationBibleEntry {
  return {
    locationId: id,
    name,
    type: 'interior',
    timeOfDay: '',
    description: '',
    architecturalStyle: '',
    keyFeatures: '',
    colorPalette: '',
    lightingSetup: '',
    ambiance: '',
    consistencyTag: id,
    firstMention: { text: '', lineNumber: 0, sceneId: 'sc-1' },
  };
}

function elementBible(id: string): ElementBibleEntry & { elementId: string } {
  return {
    elementId: id,
    token: id.toUpperCase(),
    description: '',
    consistencyTag: id,
    firstMention: { text: '', lineNumber: 0, sceneId: 'sc-1' },
  };
}

const references: PlanReferences = {
  characterSheets: [
    {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq-1',
      characterDbId: 'maya',
      characterName: 'Maya',
      characterMetadata: characterBible('maya', 'Maya'),
      castTalentDescription: null,
      snapshotInputHash: characterSheetInputHash('maya'),
      bibleVersionId: null,
    },
    {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq-1',
      characterDbId: 'ravi',
      characterName: 'Ravi',
      characterMetadata: characterBible('ravi', 'Ravi'),
      castTalentDescription: null,
      snapshotInputHash: characterSheetInputHash('ravi'),
      bibleVersionId: null,
    },
  ],
  locationSheets: [
    {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq-1',
      locationDbId: 'hall',
      locationName: 'Hall',
      locationMetadata: locationBible('hall', 'Hall'),
      snapshotInputHash: locationSheetInputHash('hall'),
      bibleVersionId: null,
    },
  ],
  elementSheets: {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'seq-1',
    entries: [elementBible('mug')],
  },
  voices: [
    {
      userId: 'u1',
      teamId: 't1',
      sequenceId: 'seq-1',
      characterDbId: 'maya',
      characterBible: characterBible('maya', 'Maya'),
      voiceDescription: '',
      analysisModelId: DEFAULT_ANALYSIS_MODEL,
      voiceProvider: 'elevenlabs',
      takes: 1,
    },
  ],
  cost: { sheets: ZERO_MICROS, voices: ZERO_MICROS },
};

describe('UpdateStaleShotsWorkflow — a continue (#1818)', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
    emit.mockClear();
    failCharacter.clear();
  });

  it('spawns only the owed references, each behind its claim', async () => {
    const result = await run(plan({ references }));
    expect(spawned().sort()).toEqual(
      [
        'spawn-character-sheet-maya',
        'spawn-character-sheet-ravi',
        'spawn-location-sheet-hall',
        'spawn-element-sheets',
        'spawn-character-voice-maya',
      ].sort()
    );
    expect(payloadOf('spawn-character-sheet-ravi')).toEqual({
      ...references.characterSheets[1],
      sheetVersionId: 'csv-ravi',
    });
    expect(payloadOf('spawn-location-sheet-hall')).toEqual({
      ...references.locationSheets[0],
      referenceVersionId: 'lrv-hall',
    });
    expect(payloadOf('spawn-character-voice-maya')).toEqual({
      ...references.voices[0],
      targetVersionId: 'husk-maya',
    });
    expect(claimSheet).toHaveBeenCalledWith('ravi', { markGenerating: true });
    expect(result.failures).toEqual([]);
    // The banner moves under a continue.
    expect(emit).toHaveBeenCalledWith(
      'generation.phase:start',
      expect.objectContaining({ phase: 2 })
    );
  });

  it('a failed sheet holds the stills made from it, and nothing else', async () => {
    failCharacter.add('ravi');
    const result = await run(
      plan({
        references: {
          ...references,
          elementSheets: null,
          voices: [],
        },
        targets: [
          target('s-ravi', ['ravi', 'hall']),
          target('s-maya', ['maya']),
        ],
      })
    );
    expect(spawned()).toContain('spawn-image-s-maya');
    expect(spawned()).not.toContain('spawn-image-s-ravi');
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ shotId: 'ravi', stage: 'reference' }),
        expect.objectContaining({ shotId: 's-ravi', stage: 'image' }),
      ])
    );
    // Cleared by the run too: a child that never started has no onFailure.
    expect(failSheetClaim).toHaveBeenCalledWith(
      'ravi',
      'csv-ravi',
      'sheet model refused'
    );
    expect(result.images).toBe(1);
  });
});
