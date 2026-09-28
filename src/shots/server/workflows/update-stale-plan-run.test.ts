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
}));
vi.doMock('@/platform/server/db/scoped', () => ({ createScopedDb: vi.fn() }));
vi.doMock('@/shots/server/scene-script', () => ({
  loadSceneContextBySequence: vi.fn(async () => new Map()),
  resolveSceneForShot: vi.fn((shot: { id: string }) => ({
    scene: {
      sceneId: shot.id,
      metadata: { title: shot.id },
      originalScript: { extract: 'Scene' },
    },
    script: null,
  })),
}));
vi.doMock('@/shots/server/shot-image-input', () => ({
  prepareShotImageWorkflowInput: vi.fn(
    async (args: { modelOverride: string }) => ({
      prompt: 'p',
      model: args.modelOverride,
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
      sequences: {
        getById: vi.fn(async () => ({
          musicStatus: 'completed',
          musicPrompt: 'edited later',
          musicTags: 'edited later',
        })),
      },
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

const run = (
  p: UpdateStalePlan,
  options: Partial<UpdateStaleShotsWorkflowInput> = {}
) =>
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
        ...options,
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

describe('executor packed clips', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
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

describe('fresh executor parity (#1891)', () => {
  beforeEach(() => {
    spawnAndAwaitChild.mockClear();
    requireCredits.mockClear();
    emit.mockClear();
    failCharacter.clear();
  });
  it('uses one prompt child per single-shot scene and carries the reservation', async () => {
    const targets = ['a', 'b'].map((id) => ({
      ...target(id, []),
      regenVisual: true,
      regenImage: false,
    }));
    const result = await run(plan({ targets }), {
      freshRun: true,
      reservationId: 'hold',
    });
    expect(result.failures).toEqual([]);
    expect(result.visualPrompts).toBe(2);
    expect(spawned()).toEqual(['spawn-frame-prompt-a', 'spawn-frame-prompt-b']);
    expect(payloadOf('spawn-frame-prompt-a')).toMatchObject({
      reservationId: 'hold',
    });
  });
  it('gates simultaneous sheet and platform voice spend together against the parent envelope', async () => {
    const p = plan({
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- children are stubbed; only ids and wave cost are consumed
      references: { ...references, cost: { sheets: 20, voices: 30 } } as never,
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
    });
  });
  it('announces every fresh phase in order and completes each', async () => {
    const a = clipTarget('a');
    a.regenImage = true;
    const p = plan({
      targets: [a],
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- reference children consume only fixture ids
      references: { ...references, voices: [] } as never,
      dialogueRecording: {
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
