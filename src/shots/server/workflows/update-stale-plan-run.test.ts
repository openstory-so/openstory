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
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { UpdateStaleShotsWorkflowInput } from '@/platform/server/workflow/types';
import type { PlanTarget, UpdateStalePlan } from '../update-stale-plan';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import * as realPlan from '../update-stale-plan';
import { buildMotionRender } from '@/motion/server/build-motion-render';
import { motionPromptFromVersion } from '@/motion/server/resolve-motion-prompt';
import { asStub } from '@/test/as-stub';

vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
const requireCredits = vi.fn(async (..._args: unknown[]) => undefined);
vi.doMock('@/billing/server/preflight', () => ({ requireCredits }));
const estimateVideoCost = vi.fn((..._args: unknown[]) => 0);
vi.doMock('@/billing/cost-estimation', () => ({
  estimateVideoCost,
  gateEstimate: vi.fn(() => 0),
}));

const emit = vi.fn(
  async (_event: string, _payload: { phase: number }) => undefined
);
vi.doMock('@/platform/realtime', () => ({
  getGenerationChannel: vi.fn(() => ({ emit })),
  getShotPromptChannel: vi.fn(() => ({ emit })),
}));
vi.doMock('@/platform/server/db/scoped', () => ({ createScopedDb: vi.fn() }));
vi.doMock('@/shots/server/scene-script', () => ({
  loadSceneContextBySequence: vi.fn(async () => new Map()),
  resolveSceneForShot: vi.fn((shot: { id: string }) => ({
    scene: {
      sceneId: shot.id,
      metadata: {
        title: shot.id,
        location: 'INT. ROOM',
        timeOfDay: 'day',
        storyBeat: 'beat',
      },
      originalScript: { extract: 'Scene', dialogue: [] },
    },
    script: null,
  })),
}));
vi.doMock('@/shots/server/shot-image-input', () => ({
  prepareShotImageWorkflowInput: vi.fn(
    async (args: { modelOverride: string }) => ({
      prompt: 'p',
      model: args.modelOverride,
      frameId: 'anchor',
      promptVersionId: 'saved-visual',
      referenceImages: [
        { referenceImageUrl: 'https://x/cast.png', description: 'cast' },
      ],
      sceneSnapshot: {
        sceneId: 'scene',
        visualPrompt: 'p',
        characterSheetHashes: ['sheet-v1'],
        locationSheetHashes: [],
        elementReferenceHashes: [],
      },
    })
  ),
}));
vi.doMock('../update-stale-plan', () => ({
  ...realPlan,
  claimTargets: vi.fn(async ({ targets }: { targets: PlanTarget[] }) => ({
    claimsByShot: Object.fromEntries(
      targets.map((t) => [
        t.shotId,
        {
          visualVersionId: t.regenVisual ? `visual-${t.shotId}` : null,
          motionVersionId: null,
          imageVariantId: `claim-${t.shotId}`,
        },
      ])
    ),
    skipped: [],
  })),
}));

const triggerWorkflow = vi.fn(async (..._args: unknown[]) => 'grid-run');
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
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
    if (args.spawnStepName === 'spawn-character-sheet-maya')
      return {
        sheetImageUrl: 'https://x/new-maya.png',
        sheetVersionId: 'new-maya-version',
      };
    if (args.spawnStepName === 'spawn-location-sheet-hall')
      return {
        referenceImageUrl: 'https://x/new-hall.png',
        referenceVersionId: 'new-hall-version',
      };
    if (args.spawnStepName.startsWith('spawn-frame-prompt-'))
      return { finalVersionId: 'visual-result' };
    if (args.spawnStepName === 'spawn-dialogue-audio')
      return { clipsByShotId: {} };
    if (args.spawnStepName === 'spawn-music-prompt')
      return { prompt: 'New music', tags: 'calm' };
    if (args.spawnStepName === 'spawn-element-sheets') return { elements: [] };
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
  // only `do` is exercised
  return asStub<WorkflowStep>({ do: run });
}

// A sheet claim is a look's (#2015); a default look's id is its character's.
const claimSheet = vi.fn(async (_sequenceId: string, lookId: string) => ({
  versionId: `csv-${lookId}`,
  held: true,
}));
const failSheetClaim = vi.fn(async () => undefined);
const adoptIfPending = vi.fn(
  async (_args: unknown): Promise<'adopted' | 'refused'> => 'adopted'
);
const claimReference = vi.fn(async (id: string) => `lrv-${id}`);
const claimMusic = vi.fn(async (): Promise<string | null> => 'music-claim');
const failMusicClaim = vi.fn(async () => undefined);
const createPendingVoiceClaim = vi.fn(async (id: string) => ({
  created: true,
  version: { id: `husk-${id}`, workflowRunId: null },
}));

function makeScopedDb(): WorkflowScopedDb {
  // minimal stub for the paths under test
  return asStub<WorkflowScopedDb>({
    characterLooks: { claimSheet, failSheetClaim },
    characterSheetVariants: { adoptIfPending },
    characters: {
      createPendingVoiceClaim,
      markVoiceClaimTerminal: vi.fn(),
    },
    sequenceLocations: { claimReference },
    sequenceVariants: { claimMusic, failMusicClaim },
    frameVariants: {
      markTerminal: vi.fn(),
      cancelByDependency: vi.fn(),
    },
    framePromptVersions: {
      completePendingAiVersion: vi.fn(async () => ({ id: 'visual-done' })),
      markTerminal: vi.fn(),
    },
    shotPromptVersions: {
      completePendingAiVersion: vi.fn(async () => ({ id: 'motion-done' })),
      markTerminal: vi.fn(),
    },
    shotSpecVersions: {
      stampInputHashIfEmpty: vi.fn(),
      clearClaimIf: vi.fn(),
    },
    stalenessPlanning: {},
    claims: {
      frameVariants: {
        getById: vi.fn(async (id: string) => ({
          id,
          status: 'completed',
          url: 'https://x/still.png',
        })),
      },
      shotPromptVersions: {
        getByIdForShot: vi.fn(async (id: string) => ({
          id,
          text: 'She crosses the room.',
          audio: null,
          status: 'completed',
        })),
      },
    },
    liveRead: {
      compliance: { listEnforcementFor: vi.fn(async () => []) },
      apiKeys: { hasUsableKey: vi.fn(async () => false) },
      billing: { hasEnoughCredits: vi.fn(async () => true) },
      characters: { listWithSheets: vi.fn(async () => []) },
      sequenceLocations: { listWithReferences: vi.fn(async () => []) },
      sequenceElements: { list: vi.fn(async () => []) },
      shots: {
        getById: vi.fn(async (id: string) => ({
          id,
          sceneId: 'edited-scene',
          renderSegmentId: 'edited-segment',
          audioClips: [],
        })),
      },
      videoVariants: {
        getSelectedByShot: vi.fn(async (id: string) => ({
          id: 'old-video',
          model: 'grok_imagine_video_1_5',
          manifest: [
            {
              shotId: id,
              motionPromptVersionId: 'old-prompt',
              frameVersionId: null,
            },
          ],
        })),
        listBySegment: vi.fn(async () => []),
      },
      frames: {
        getAnchorByShot: vi.fn(async (id: string) => ({ id: `f-${id}` })),
      },
    },
  });
}

function target(shotId: string, referenceIds: string[]): PlanTarget {
  return {
    shotId,
    frameId: `f-${shotId}`,
    startingFrameImageUrl: null,
    usesStartFrame: true,
    durationMs: null,
    standingImageVariantId: null,
    standingMotionVersionId: null,
    visualPromptVersionId: null,
    regenVisual: false,
    regenMotion: false,
    rewriteSpec: false,
    specVersionId: null,
    spec: null,
    specInputHash: null,
    visualWritten: false,
    motionWritten: false,
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
    motionRender: {
      packedScene: {},
      description: '',
      selectedModel: null,
      characterLooks: null,
    },
    regenDialogue: false,
    dialogue: { presence: false, lines: [] },
    dialogueContext: [],
  };
}

function plan(overrides: Partial<UpdateStalePlan>): UpdateStalePlan {
  // the executor reads only these fields here
  return asStub<UpdateStalePlan>({
    aspectRatio: '16:9',
    resolution: '1080p',
    sequence: { title: 'S', videoModel: 'kling_v3_pro' },
    music: null,
    promptContext: {
      characterBible: [],
      locationBible: [],
      elementBible: [],
      styleConfig: {},
      analysisModelId: 'x',
    },
    characterVoices: [],
    dialogueSpeech: null,
    renderRefs: { characters: [], locations: [], elements: [] },
    scenePrompts: {},
    targets: [],
    skipped: [],
    references: null,
    ...overrides,
  });
}

const run = (
  p: UpdateStalePlan,
  options: Partial<UpdateStaleShotsWorkflowInput> = {}
) =>
  new Testable(
    // ctx is never read
    asStub<ConstructorParameters<typeof Testable>[0]>(undefined),
    // children are mocked, no binding is dereferenced
    asStub<ConstructorParameters<typeof Testable>[1]>({})
  ).invoke(
    // minimal event stub
    asStub<Readonly<WorkflowEvent<UpdateStaleShotsWorkflowInput>>>({
      payload: {
        userId: 'u1',
        teamId: 't1',
        sequenceId: 'seq-1',
        plan: p,
        announcePhases: true,
        ...options,
      },
      instanceId: 'run-1',
    })
  );

const spawned = () =>
  spawnAndAwaitChild.mock.calls.map(([, args]) => args.spawnStepName);
const payloadOf = (step: string) =>
  spawnAndAwaitChild.mock.calls.find(([, a]) => a.spawnStepName === step)?.[1]
    .childPayload;

const references = {
  characterSheets: [
    { characterDbId: 'maya', lookId: 'maya', lookVersionId: 'lv-maya' },
    {
      characterDbId: 'ravi',
      lookId: 'ravi',
      lookVersionId: 'lv-ravi',
      bibleVersionId: 'bible-ravi',
      talentId: null,
    },
  ],
  lookSheetsAfterDefault: [],
  reusedSheets: [],
  locationSheets: [{ locationDbId: 'hall' }],
  elementSheets: { entries: [{ elementId: 'mug' }] },
  voices: [{ characterDbId: 'maya' }],
  cost: { sheets: 0, voices: 0 },
};

describe('UpdateStaleShotsWorkflow — a continue (#1818)', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
    triggerWorkflow.mockClear();
    emit.mockClear();
    failCharacter.clear();
  });

  it('spawns only the owed references, each behind its claim', async () => {
    const result = await run(
      // payload stubs
      plan({ references: asStub<never>(references) })
    );
    expect(spawned().sort()).toEqual(
      [
        'spawn-character-sheet-maya',
        'spawn-character-sheet-ravi',
        'spawn-location-sheet-hall',
        'spawn-element-sheets',
        'spawn-character-voice-maya',
      ].sort()
    );
    expect(payloadOf('spawn-character-sheet-ravi')).toEqual(
      expect.objectContaining({
        characterDbId: 'ravi',
        lookId: 'ravi',
        sheetVersionId: 'csv-ravi',
      })
    );
    expect(payloadOf('spawn-location-sheet-hall')).toEqual({
      locationDbId: 'hall',
      referenceVersionId: 'lrv-hall',
    });
    expect(payloadOf('spawn-character-voice-maya')).toEqual({
      characterDbId: 'maya',
      targetVersionId: 'husk-maya',
    });
    // The claim is taken on the look the payload names, as it was frozen.
    expect(claimSheet).toHaveBeenCalledWith(
      'seq-1',
      'ravi',
      {
        lookVersionId: 'lv-ravi',
        bibleVersionId: 'bible-ravi',
        talentId: null,
      },
      { markGenerating: true }
    );
    expect(result.failures).toEqual([]);
    // The banner moves under a continue.
    expect(emit).toHaveBeenCalledWith(
      'generation.phase:start',
      expect.objectContaining({ phase: 2 })
    );
  });

  it('claims and spawns each look on its own, from the snapshot it was built from (#2015)', async () => {
    await run(
      plan({
        // payload stubs
        references: asStub<never>({
          ...references,
          characterSheets: [
            {
              characterDbId: 'maya',
              lookId: 'maya',
              lookVersionId: 'lookver-default',
              bibleVersionId: 'bible-1',
              talentId: 'talent-1',
            },
            {
              characterDbId: 'maya',
              lookId: 'gala',
              lookVersionId: 'lookver-gala',
              bibleVersionId: 'bible-1',
              talentId: 'talent-1',
            },
          ],
          locationSheets: [],
          elementSheets: null,
          voices: [],
        }),
      })
    );
    expect(spawned().sort()).toEqual([
      'spawn-character-sheet-gala',
      'spawn-character-sheet-maya',
    ]);
    expect(claimSheet).toHaveBeenCalledWith(
      'seq-1',
      'gala',
      {
        lookVersionId: 'lookver-gala',
        bibleVersionId: 'bible-1',
        talentId: 'talent-1',
      },
      { markGenerating: true }
    );
    expect(payloadOf('spawn-character-sheet-gala')).toMatchObject({
      lookId: 'gala',
      sheetVersionId: 'csv-gala',
    });
  });

  it('draws a look after its default sheet lands, from that sheet, in the same run (#2015)', async () => {
    const gala = {
      characterDbId: 'maya',
      characterName: 'Maya',
      lookId: 'gala',
      lookVersionId: 'lookver-gala',
      lookStyling: null,
      bibleVersionId: 'bible-1',
      talentId: null,
      // what the hash reads
      characterMetadata: {
        name: 'Maya',
        age: '30s',
        gender: '',
        ethnicity: '',
        physicalDescription: '',
        standardClothing: 'red gown',
        distinguishingFeatures: '',
        consistencyTag: 'maya',
      },
      imageModel: 'nano_banana_2',
      talentSheetInputHash: null,
      castTalentDescription: null,
    };
    await run(
      plan({
        // payload stubs
        references: asStub<never>({
          ...references,
          characterSheets: [references.characterSheets[0]],
          lookSheetsAfterDefault: [gala],
          locationSheets: [],
          elementSheets: null,
          voices: [],
        }),
      })
    );
    // The look is spawned after the default, never beside it.
    expect(spawned()).toEqual([
      'spawn-character-sheet-maya',
      'spawn-character-sheet-gala',
    ]);
    // Its claim was taken at kickoff, before the default's child ran: a
    // user regenerate between the waves takes a newer claim, and this run's
    // sheet (landing under the older id) parks — the newer click wins
    // (sheet-claims.test: "lets a newer kickoff win over a late completion").
    const galaClaim =
      claimSheet.mock.invocationCallOrder[
        claimSheet.mock.calls.findIndex(([, lookId]) => lookId === 'gala')
      ];
    const mayaSpawn =
      spawnAndAwaitChild.mock.invocationCallOrder[
        spawnAndAwaitChild.mock.calls.findIndex(
          ([, args]) => args.spawnStepName === 'spawn-character-sheet-maya'
        )
      ];
    expect(galaClaim).toBeLessThan(mayaSpawn ?? 0);
    // Its face is the sheet this run landed, not a re-read.
    expect(payloadOf('spawn-character-sheet-gala')).toMatchObject({
      lookId: 'gala',
      face: {
        url: 'https://x/new-maya.png',
        versionId: 'new-maya-version',
      },
      snapshotInputHash: expect.any(String),
      sheetVersionId: 'csv-gala',
    });
  });

  it('fails a look whose default sheet did not land, and holds what wears it', async () => {
    failCharacter.add('maya');
    const result = await run(
      plan({
        // payload stubs
        references: asStub<never>({
          ...references,
          characterSheets: [references.characterSheets[0]],
          lookSheetsAfterDefault: [
            {
              characterDbId: 'maya',
              characterName: 'Maya',
              lookId: 'gala',
              lookVersionId: 'lookver-gala',
            },
          ],
          locationSheets: [],
          elementSheets: null,
          voices: [],
        }),
      })
    );
    expect(spawned()).toEqual(['spawn-character-sheet-maya']);
    expect(result.failures.map((failure) => failure.shotId)).toEqual(
      expect.arrayContaining(['maya', 'gala'])
    );
    expect(
      result.failures.find((failure) => failure.shotId === 'gala')?.error
    ).toContain('default look sheet did not land in this run');
    // The claim taken at kickoff is cleared, by its own id: nothing is left
    // holding the look.
    expect(failSheetClaim).toHaveBeenCalledWith(
      'seq-1',
      'gala',
      'csv-gala',
      expect.stringContaining('did not land')
    );
  });

  it('a failed sheet holds the stills made from it, and nothing else', async () => {
    failCharacter.add('ravi');
    const result = await run(
      plan({
        // payload stubs
        references: asStub<never>({
          ...references,
          elementSheets: null,
          voices: [],
        }),
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
      'seq-1',
      'ravi',
      'csv-ravi',
      'sheet model refused'
    );
    expect(result.images).toBe(1);
  });

  const reusedMaya = {
    payload: {
      characterDbId: 'maya',
      characterName: 'Maya',
      lookId: 'maya',
      lookVersionId: 'lv-maya',
      bibleVersionId: 'bible-1',
      talentId: null,
      imageModel: 'nano_banana_2',
      snapshotInputHash: 'hash-maya',
    },
    sheetVersionId: 'ep1-maya',
    url: 'https://x/ep1-maya.png',
    storagePath: 'ep1-maya.png',
  };

  it('adopts a sheet the plan found finished elsewhere through its claim, drawing nothing (#2017)', async () => {
    const result = await run(
      plan({
        // payload stubs
        references: asStub<never>({
          ...references,
          characterSheets: [],
          reusedSheets: [reusedMaya],
          locationSheets: [],
          elementSheets: null,
          voices: [],
        }),
        targets: [target('s-maya', ['maya'])],
      })
    );
    // The same claim a draw takes, then the pointer, in one guarded write.
    expect(claimSheet).toHaveBeenCalledWith(
      'seq-1',
      'maya',
      { lookVersionId: 'lv-maya', bibleVersionId: 'bible-1', talentId: null },
      { markGenerating: true }
    );
    expect(adoptIfPending).toHaveBeenCalledWith({
      sequenceId: 'seq-1',
      lookId: 'maya',
      claimVersionId: 'csv-maya',
      sheetVersionId: 'ep1-maya',
      model: 'nano_banana_2',
      inputHash: 'hash-maya',
    });
    expect(spawned()).not.toContain('spawn-character-sheet-maya');
    expect(emit).toHaveBeenCalledWith('generation.character-sheet:progress', {
      characterId: 'maya',
      lookId: 'maya',
      status: 'completed',
      sheetImageUrl: 'https://x/ep1-maya.png',
    });
    // The still that wears it renders, from the adopted sheet.
    expect(spawned()).toContain('spawn-image-s-maya');
    expect(result.failures).toEqual([]);
  });

  it('fails the sheet when the adopt is refused, holds its stills and never draws instead', async () => {
    adoptIfPending.mockResolvedValueOnce('refused');
    const result = await run(
      plan({
        // payload stubs
        references: asStub<never>({
          ...references,
          characterSheets: [],
          reusedSheets: [reusedMaya],
          locationSheets: [],
          elementSheets: null,
          voices: [],
        }),
        targets: [target('s-maya', ['maya'])],
      })
    );
    expect(spawned()).not.toContain('spawn-character-sheet-maya');
    expect(spawned()).not.toContain('spawn-image-s-maya');
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          shotId: 'maya',
          stage: 'reference',
          error: expect.stringContaining('was not reused'),
        }),
        expect.objectContaining({ shotId: 's-maya', stage: 'image' }),
      ])
    );
    expect(failSheetClaim).toHaveBeenCalledWith(
      'seq-1',
      'maya',
      'csv-maya',
      expect.stringContaining('was not reused')
    );
  });

  it('refuses a plan frozen before sheet reuse', async () => {
    await expect(
      run(
        plan({
          // an older plan: no reusedSheets field
          references: asStub<never>({ ...references, reusedSheets: undefined }),
        })
      )
    ).rejects.toThrow('predates sheet reuse');
  });
});

const clipTarget = (id: string): PlanTarget => ({
  ...target(id, []),
  regenImage: false,
  regenVideo: true,
  usesStartFrame: false,
  standingMotionVersionId: `prompt-${id}`,
  staleVideoVersionId: 'old-video',
  durationMs: 4000,
  motionRender: {
    sceneId: 'scene-1',
    renderSegmentId: 'segment-1',
    packedScene: { location: 'Frozen room' },
    characterLooks: null,
    description: '',
    selectedModel: 'kling_v3_pro',
  },
});

describe('executor packed clips', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
    triggerWorkflow.mockClear();
    failCharacter.clear();
  });
  it('deduplicates stale siblings into one generation using frozen membership and model', async () => {
    const result = await run(
      plan({ targets: [clipTarget('a'), clipTarget('b')] })
    );
    expect(result.failures).toEqual([]);
    expect(spawned().filter((name) => name.startsWith('spawn-video-'))).toEqual(
      ['spawn-video-a']
    );
    expect(payloadOf('spawn-video-a')).toMatchObject({
      model: 'kling_v3_pro',
      sceneId: 'scene-1',
      duration: 8,
      coveredShots: [{ shotId: 'a' }, { shotId: 'b' }],
      packedScene: { location: 'Frozen room' },
    });
    expect(result.videos).toBe(1);
  });
  it.each([true, false])(
    'submits manual-equivalent packed prompts through the shared executor (freshRun=%s)',
    async (freshRun) => {
      const dialogue = { presence: false, lines: [] };
      const version = { text: 'She crosses the room.', audio: null };
      const ids = ['a', 'b'];
      const context = { userId: 'u1', teamId: 't1', sequenceId: 'seq-1' };
      const header = {
        location: 'Frozen room',
        timeOfDay: 'Night',
        lightingSetup: 'overhead lamp',
        colorPalette: 'cold blue',
        look: 'watercolour, cool shadows',
      };
      // The manual path reconstructs selected immutable prompt rows and D1 scene data.
      const manualJobs = buildMotionRender({
        ...context,
        shots: ids.map((shotId) => ({
          shotId,
          sceneId: 'scene-1',
          renderSegmentId: 'segment-1',
          referenceOnly: true,
          seedanceEditSeconds: null,
          packedScene: header,
          attachSceneHeader: true,
          duration: 2,
          model: 'kling_v3_pro',
          prompt: version.text,
          motionPrompt: motionPromptFromVersion(version, dialogue),
          characterTags: [],
          motionPromptVersionId: `prompt-${shotId}`,
        })),
      });
      const expected = {
        prompt: manualJobs[0]?.input.prompt,
        multiPrompt: manualJobs[0]?.input.multiPrompt,
      };
      expect(manualJobs).toHaveLength(1);
      const targets = ids.map((id) => ({
        ...clipTarget(id),
        durationMs: 2000,
        attachSceneHeader: true,
        motionRender: {
          ...clipTarget(id).motionRender,
          packedScene: header,
          characterTags: [],
        },
      }));
      const result = await run(plan({ targets }), { freshRun });
      expect(result.failures).toEqual([]);
      expect(
        spawned().filter((name) => name.startsWith('spawn-video-'))
      ).toEqual(['spawn-video-a']);
      expect(payloadOf('spawn-video-a')).toMatchObject(expected);
    }
  );

  it('uses click-time reference URLs instead of reloading selection pointers', async () => {
    const shot = clipTarget('a');
    shot.motionRender.location = 'Frozen room';
    const p = plan({ targets: [shot] });
    // only matching and reference fields are used
    p.renderRefs.locations = asStub<typeof p.renderRefs.locations>([
      {
        id: 'room',
        locationId: 'room',
        name: 'Frozen room',
        description: 'A room',
        referenceImageUrl: 'https://x/frozen.jpg',
        selectedReferenceVersionId: 'frozen-version',
      },
    ]);
    const result = await run(p);
    expect(result.failures).toEqual([]);
    expect(payloadOf('spawn-video-a')).toMatchObject({
      referenceImages: [{ referenceImageUrl: 'https://x/frozen.jpg' }],
    });
  });

  it('holds the entire persisted clip when one sibling cannot render', async () => {
    const missing = clipTarget('b');
    missing.standingMotionVersionId = null;
    const result = await run(plan({ targets: [clipTarget('a'), missing] }));
    expect(spawned().filter((name) => name.startsWith('spawn-video-'))).toEqual(
      []
    );
    expect(result.failures.map((failure) => failure.shotId).sort()).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('fresh executor parity (#1891)', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
    triggerWorkflow.mockClear();
    requireCredits.mockClear();
    emit.mockClear();
    failCharacter.clear();
  });
  it('rebuilds each shot from its spec without a prompt model', async () => {
    const spec = {
      framing: {
        shotSize: 'wide',
        angle: 'eye level',
        composition: 'centered',
        subjectStartState: 'at the door',
      },
      action: 'she runs',
      cameraMovement: { move: 'dolly in, then pan left', pacing: 'quick' },
      direction: '',
      soundCue: '',
    };
    const targets = ['a', 'b'].map((id) => ({
      ...target(id, []),
      regenVisual: true,
      regenImage: false,
      spec,
      specVersionId: `spec-${id}`,
      specInputHash: 'currency',
    }));
    const base = plan({ targets });
    const result = await run(
      {
        ...base,
        promptContext: base.promptContext && {
          ...base.promptContext,
          styleConfig: {
            version: 2,
            look: {
              colorPalette: ['#111'],
              medium: 'film',
              artStyle: 'noir',
              colorGrading: 'teal',
              mood: 'tense',
              lighting: 'low',
            },
            motion: { camera: 'push in' },
            references: [],
          },
        },
      },
      { freshRun: true, reservationId: 'hold' }
    );
    expect(result.failures).toEqual([]);
    expect(result.visualPrompts).toBe(2);
    expect(spawned().filter((name) => name.includes('prompt'))).toEqual([]);
  });
  it('gates simultaneous sheet and platform voice spend together against the parent envelope', async () => {
    const p = plan({
      // children are stubbed; only ids and wave cost are consumed
      references: asStub<never>({
        ...references,
        cost: { sheets: 20, voices: 30 },
      }),
    });
    await run(p, { reservationId: 'hold' });
    expect(requireCredits).toHaveBeenCalledWith(
      expect.anything(),
      50,
      expect.objectContaining({ providers: [], reservationId: 'hold' })
    );
    expect(payloadOf('spawn-character-voice-maya')).toMatchObject({
      reservationId: 'hold',
    });
  });

  it('renders each image model once with one selectable primary and shared reservation', async () => {
    const result = await run(
      plan({
        targets: [target('a', [])],
        renderOptions: { imageModels: ['nano_banana_2', 'seedream_v5'] },
      }),
      { freshRun: true, reservationId: 'hold' }
    );
    expect(result.failures).toEqual([]);
    expect(result.images).toBe(2);
    expect(triggerWorkflow).toHaveBeenCalledTimes(2);
    for (const model of ['nano_banana_2', 'seedream_v5']) {
      expect(triggerWorkflow).toHaveBeenCalledWith(
        '/variant-image',
        expect.objectContaining({
          shotId: 'a',
          thumbnailUrl: 'https://x/still.png',
          scenePrompt: 'p',
          frameId: 'anchor',
          promptVersionId: 'saved-visual',
          referenceImages: [
            { referenceImageUrl: 'https://x/cast.png', description: 'cast' },
          ],
          tileHashInput: expect.objectContaining({
            visualPrompt: 'p',
            characterSheetHashes: ['sheet-v1'],
          }),
          model,
        }),
        expect.objectContaining({
          deduplicationId: expect.stringContaining(`-a-${model}`),
          enforcement: [],
        })
      );
    }
    expect(
      triggerWorkflow.mock.calls.every(
        (call) => !Object.hasOwn(Object(call[1]), 'reservationId')
      )
    ).toBe(true);

    expect(payloadOf('spawn-image-a')).toMatchObject({
      model: 'nano_banana_2',
      targetVariantId: 'claim-a',
      variantOnly: false,
      reservationId: 'hold',
    });
    expect(payloadOf('spawn-image-a-seedream_v5')).toMatchObject({
      model: 'seedream_v5',
      variantOnly: true,
      reservationId: 'hold',
    });
    expect(payloadOf('spawn-image-a-seedream_v5')).not.toHaveProperty(
      'targetVariantId',
      'claim-a'
    );
  });
  it('does not start fresh enrichment grids during Continue', async () => {
    await run(plan({ targets: [target('a', [])] }));
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });

  it.each([{ cancelled: true, imageUrl: '' }, { imageUrl: '' }])(
    'does not start a grid when the still produces no artifact (%j)',
    async (output) => {
      spawnAndAwaitChild.mockResolvedValueOnce(output);
      await run(plan({ targets: [target('a', [])] }), { freshRun: true });
      expect(triggerWorkflow).not.toHaveBeenCalled();
    }
  );

  it('renders video alternatives without overriding a leftover Grok choice', async () => {
    const result = await run(
      plan({
        targets: [
          clipTarget('a'),
          {
            ...clipTarget('b'),
            motionRender: {
              ...clipTarget('b').motionRender,
              renderSegmentId: 'other',
            },
          },
        ],
        renderOptions: { videoModels: ['kling_v3_pro', 'seedance_v2'] },
      }),
      { freshRun: true, reservationId: 'hold', leftoverGrokShotIds: ['b'] }
    );
    expect(result.failures).toEqual([]);
    expect(result.videos).toBe(3);
    expect(payloadOf('spawn-video-a')).toMatchObject({
      model: 'kling_v3_pro',
      variantOnly: false,
      reservationId: 'hold',
    });
    expect(payloadOf('spawn-video-a-seedance_v2')).toMatchObject({
      model: 'seedance_v2',
      variantOnly: true,
      reservationId: 'hold',
    });
    expect(payloadOf('spawn-video-b')).toMatchObject({
      model: 'grok_imagine_video_1_5',
      reservationId: 'hold',
    });
  });
  it('renders all alternatives when Grok is the first model', async () => {
    const result = await run(
      plan({
        targets: [clipTarget('a')],
        renderOptions: {
          videoModels: ['grok_imagine_video_1_5', 'kling_v3_pro'],
        },
      }),
      { freshRun: true }
    );
    expect(result.failures).toEqual([]);
    expect(result.videos).toBe(2);
    expect(payloadOf('spawn-video-a')).toMatchObject({
      model: 'grok_imagine_video_1_5',
      variantOnly: false,
    });
    expect(payloadOf('spawn-video-a-kling_v3_pro')).toMatchObject({
      model: 'kling_v3_pro',
      variantOnly: true,
    });
  });
  it('keeps prompt-only music work in the fresh Images phase', async () => {
    const result = await run(
      plan({
        targets: [],
        music: {
          regenPrompt: true,
          regenTrack: false,
          sceneSummaries: [],
          analysisModelId: DEFAULT_ANALYSIS_MODEL,
          promptSource: 'regenerated',
          durationSeconds: 30,
          prompt: null,
          tags: null,
        },
      }),
      { freshRun: true }
    );
    expect(result.failures).toEqual([]);
    expect(result.musicPrompts).toBe(1);
    expect(result.musicTracks).toBe(0);
    expect(emit.mock.calls.map(([event, body]) => [event, body.phase])).toEqual(
      [
        ['generation.phase:start', 3],
        ['generation.phase:complete', 3],
      ]
    );
  });
  it('keeps the saved draft switch on motion payloads', async () => {
    const a = clipTarget('a');
    a.motionRender.selectedModel = 'seedance_v2_5';
    const p = plan({ targets: [a] });
    p.sequence.draftMotion = true;
    await run(p);
    expect(payloadOf('spawn-video-a')).toMatchObject({ draft: true });
    expect(estimateVideoCost).toHaveBeenLastCalledWith(
      'seedance_v2_5',
      expect.any(Number),
      expect.objectContaining({ resolution: '480p' })
    );
  });
  it('freezes track-only music text and shares the reservation with music', async () => {
    const p = plan({
      music: {
        regenPrompt: false,
        regenTrack: true,
        sceneSummaries: [],
        analysisModelId: DEFAULT_ANALYSIS_MODEL,
        promptSource: 'regenerated',
        durationSeconds: 30,
        prompt: 'Frozen score',
        tags: 'frozen',
      },
    });
    const result = await run(p, { freshRun: true, reservationId: 'hold' });
    expect(result.failures).toEqual([]);
    expect(payloadOf('spawn-music-track')).toMatchObject({
      prompt: 'Frozen score',
      tags: 'frozen',
      reservationId: 'hold',
      isPrimary: true,
      variantId: 'music-claim',
    });
    // The claim is taken only while no other primary track run holds it.
    expect(claimMusic).toHaveBeenLastCalledWith(
      expect.objectContaining({ isPrimary: true, ifPendingIs: null })
    );
  });
  it('makes neither prompt nor track while another run holds the music claim', async () => {
    claimMusic.mockResolvedValueOnce(null);
    spawnAndAwaitChild.mockClear();
    const result = await run(
      plan({
        music: {
          regenPrompt: true,
          regenTrack: true,
          sceneSummaries: [],
          analysisModelId: DEFAULT_ANALYSIS_MODEL,
          promptSource: 'regenerated',
          durationSeconds: 30,
          prompt: 'score',
          tags: 'calm',
        },
      })
    );
    expect(result.failures).toEqual([]);
    expect(result.musicPrompts).toBe(0);
    expect(result.musicTracks).toBe(0);
    const spawned = spawnAndAwaitChild.mock.calls.map(
      ([, args]) => args.spawnStepName
    );
    expect(spawned).not.toContain('spawn-music-prompt');
    expect(spawned).not.toContain('spawn-music-track');
  });
  it('hands the track claim to the prompt child so a failed prompt fails it', async () => {
    const result = await run(
      plan({
        music: {
          regenPrompt: true,
          regenTrack: true,
          sceneSummaries: [],
          analysisModelId: DEFAULT_ANALYSIS_MODEL,
          promptSource: 'regenerated',
          durationSeconds: 30,
          prompt: 'score',
          tags: 'calm',
        },
      })
    );
    expect(result.failures).toEqual([]);
    expect(payloadOf('spawn-music-prompt')).toMatchObject({
      musicVariantId: 'music-claim',
    });
    expect(payloadOf('spawn-music-track')).toMatchObject({
      prompt: 'New music',
      variantId: 'music-claim',
    });
  });
  it('announces every fresh phase in order and completes each', async () => {
    const a = clipTarget('a');
    a.regenImage = true;
    const p = plan({
      targets: [a],
      // reference children consume only fixture ids
      references: asStub<never>({ ...references, voices: [] }),
      dialogueSpeech: {
        scenes: [
          {
            voiced: [],
            dialogueVersionIdByShotId: {},
            shotSeconds: {},
            forceAdoptShotIds: [],
          },
        ],
        minDurationSeconds: 1,
        maxDurationSeconds: 10,
      },
      music: {
        regenPrompt: false,
        regenTrack: true,
        sceneSummaries: [],
        analysisModelId: DEFAULT_ANALYSIS_MODEL,
        promptSource: 'regenerated',
        durationSeconds: 30,
        prompt: 'score',
        tags: 'calm',
      },
    });
    const result = await run(p, { freshRun: true, reservationId: 'hold' });
    expect(result.failures).toEqual([]);
    const phases = emit.mock.calls;
    expect(
      phases
        .filter(([event]) => event === 'generation.phase:start')
        .map(([, body]) => body.phase)
    ).toEqual([2, 3, 4, 5, 6]);
    expect(
      phases
        .filter(([event]) => event === 'generation.phase:complete')
        .map(([, body]) => body.phase)
    ).toEqual([2, 3, 4, 5, 6]);
    expect(payloadOf('spawn-character-sheet-maya')).toMatchObject({
      reservationId: 'hold',
    });
    expect(payloadOf('spawn-location-sheet-hall')).toMatchObject({
      reservationId: 'hold',
    });
    expect(payloadOf('spawn-element-sheets')).toMatchObject({
      reservationId: 'hold',
    });
  });
});

it('overlays first generated sheets onto the pending bible rows before a fresh still', async () => {
  spawnAndAwaitChild.mockClear();
  failCharacter.clear();
  const { prepareShotImageWorkflowInput } =
    await import('@/shots/server/shot-image-input');
  vi.mocked(prepareShotImageWorkflowInput).mockClear();
  const result = await run(
    plan({
      // minimal child payloads
      references: asStub<never>({
        characterSheets: [
          { characterDbId: 'maya', lookId: 'maya', lookVersionId: 'lv-maya' },
        ],
        lookSheetsAfterDefault: [],
        reusedSheets: [],
        locationSheets: [{ locationDbId: 'hall' }],
        elementSheets: null,
        voices: [],
        cost: { sheets: 0, voices: 0 },
      }),
      // pending row identity and media are the exercised fields
      renderRefs: asStub<never>({
        characters: [
          {
            id: 'maya',
            lookId: 'maya',
            looks: [],
            sheetImageUrl: null,
            selectedSheetVersionId: null,
          },
        ],
        locations: [
          {
            id: 'hall',
            referenceImageUrl: null,
            selectedReferenceVersionId: null,
          },
        ],
        elements: [],
      }),
      targets: [target('fresh-shot', ['maya', 'hall'])],
    }),
    { freshRun: true }
  );
  expect(result.failures).toEqual([]);
  expect(prepareShotImageWorkflowInput).toHaveBeenCalledWith(
    expect.objectContaining({
      refs: expect.objectContaining({
        characters: [
          expect.objectContaining({
            id: 'maya',
            sheetImageUrl: 'https://x/new-maya.png',
            selectedSheetVersionId: 'new-maya-version',
          }),
        ],
        locations: [
          expect.objectContaining({
            id: 'hall',
            referenceImageUrl: 'https://x/new-hall.png',
            selectedReferenceVersionId: 'lrv-hall',
          }),
        ],
      }),
    })
  );
});
