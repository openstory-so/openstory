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
import * as realPlan from '../update-stale-plan';

vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: vi.fn(async () => ({})),
}));
vi.doMock('@/billing/server/preflight', () => ({
  requireCredits: vi.fn(async () => undefined),
}));
vi.doMock('@/billing/cost-estimation', () => ({
  estimateVideoCost: vi.fn(() => 0),
  gateEstimate: vi.fn(() => 0),
}));

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
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only `do` is exercised
  return { do: run } as unknown as WorkflowStep;
}

const claimSheet = vi.fn(async (id: string) => `csv-${id}`);
const failSheetClaim = vi.fn(async () => undefined);
const claimReference = vi.fn(async (id: string) => `lrv-${id}`);
const createPendingVoiceClaim = vi.fn(async (id: string) => ({
  created: true,
  version: { id: `husk-${id}`, workflowRunId: null },
}));

function makeScopedDb(): WorkflowScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal stub for the paths under test
  return {
    characters: {
      claimSheet,
      failSheetClaim,
      createPendingVoiceClaim,
      markVoiceClaimTerminal: vi.fn(),
    },
    sequenceLocations: { claimReference },
    frameVariants: { markTerminal: vi.fn() },
    stalenessPlanning: {},
    claims: {
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
  } as unknown as WorkflowScopedDb;
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
    motionRender: { packedScene: {}, description: '', selectedModel: null },
    regenDialogue: false,
    dialogue: { presence: false, lines: [] },
    dialogueContext: [],
  };
}

function plan(overrides: Partial<UpdateStalePlan>): UpdateStalePlan {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the executor reads only these fields here
  return {
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
    dialogueRecording: null,
    renderRefs: { characters: [], locations: [], elements: [] },
    targets: [],
    skipped: [],
    references: null,
    ...overrides,
  } as unknown as UpdateStalePlan;
}

const run = (p: UpdateStalePlan) =>
  new Testable(
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- ctx is never read
    undefined as unknown as ConstructorParameters<typeof Testable>[0],
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- children are mocked, no binding is dereferenced
    {} as unknown as ConstructorParameters<typeof Testable>[1]
  ).invoke(
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal event stub
    {
      payload: {
        userId: 'u1',
        teamId: 't1',
        sequenceId: 'seq-1',
        plan: p,
        announcePhases: true,
      },
      instanceId: 'run-1',
    } as unknown as Readonly<WorkflowEvent<UpdateStaleShotsWorkflowInput>>
  );

const spawned = () =>
  spawnAndAwaitChild.mock.calls.map(([, args]) => args.spawnStepName);
const payloadOf = (step: string) =>
  spawnAndAwaitChild.mock.calls.find(([, a]) => a.spawnStepName === step)?.[1]
    .childPayload;

const references = {
  characterSheets: [{ characterDbId: 'maya' }, { characterDbId: 'ravi' }],
  locationSheets: [{ locationDbId: 'hall' }],
  elementSheets: { entries: [{ elementId: 'mug' }] },
  voices: [{ characterDbId: 'maya' }],
  cost: { sheets: 0, voices: 0 },
};

describe('UpdateStaleShotsWorkflow — a continue (#1818)', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
    emit.mockClear();
    failCharacter.clear();
  });

  it('spawns only the owed references, each behind its claim', async () => {
    const result = await run(
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- payload stubs
      plan({ references: references as never })
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
    expect(payloadOf('spawn-character-sheet-ravi')).toEqual({
      characterDbId: 'ravi',
      sheetVersionId: 'csv-ravi',
    });
    expect(payloadOf('spawn-location-sheet-hall')).toEqual({
      locationDbId: 'hall',
      referenceVersionId: 'lrv-hall',
    });
    expect(payloadOf('spawn-character-voice-maya')).toEqual({
      characterDbId: 'maya',
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
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- payload stubs
        references: {
          ...references,
          elementSheets: null,
          voices: [],
        } as never,
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

describe('executor packed clips', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
    failCharacter.clear();
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
      description: '',
      selectedModel: 'kling_v3_pro',
    },
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
  it('uses click-time reference URLs instead of reloading selection pointers', async () => {
    const shot = clipTarget('a');
    shot.motionRender.location = 'Frozen room';
    const p = plan({ targets: [shot] });
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- only matching and reference fields are used
    p.renderRefs.locations = [
      {
        id: 'room',
        locationId: 'room',
        name: 'Frozen room',
        description: 'A room',
        referenceImageUrl: 'https://x/frozen.jpg',
        selectedReferenceVersionId: 'frozen-version',
      },
    ] as typeof p.renderRefs.locations;
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
