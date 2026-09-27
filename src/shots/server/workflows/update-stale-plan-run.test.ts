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
    liveRead: {
      characters: { listWithSheets: vi.fn(async () => []) },
      sequenceLocations: { listWithReferences: vi.fn(async () => []) },
      sequenceElements: { list: vi.fn(async () => []) },
      shots: { getById: vi.fn(async (id: string) => ({ id })) },
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
    referenceIds,
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
