import { describe, expect, it, vi } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import type { Scene } from '@/shots/scene-analysis.schema';
import type { StoredShotSpec } from '@/shots/shot-list.schema';
import {
  hashShotSpecInput,
  specCurrencyFromScene,
} from '@/shots/shot-spec-currency';
import * as realPromptContext from './prompt-context';
import { asStub } from '@/test/as-stub';

const styleConfig = migrateStyleConfigV1ToV2({
  mood: 'tense',
  artStyle: 'neo-noir cinematic',
  lighting: 'low key',
  colorPalette: ['#111', '#eee'],
  cameraWork: 'handheld',
  referenceFilms: [],
  colorGrading: 'teal and orange',
});

const scene: Scene = {
  sceneId: 'scene-1',
  sceneNumber: 1,
  originalScript: { extract: 'She runs.', dialogue: [] },
  metadata: {
    title: 'Hall',
    durationSeconds: 4,
    location: 'INT. HALL',
    timeOfDay: 'night',
    storyBeat: 'chase',
  },
  continuity: {
    characterTags: [],
    environmentTag: 'hall',
    elementTags: [],
    colorPalette: '',
    lightingSetup: 'bulb',
    styleTag: '',
  },
};

const spec: StoredShotSpec = {
  framing: {
    shotSize: 'wide',
    angle: 'eye level',
    composition: 'down the hall',
    subjectStartState: 'at the door',
  },
  action: 'she runs',
  cameraMovement: { move: 'dolly in, then pan left', pacing: 'quick' },
  direction: '',
  soundCue: 'footsteps',
};

const noLines = { dialogue: { presence: false, lines: [] }, onNode: true };
const currencyHash = await hashShotSpecInput(specCurrencyFromScene(scene, []));

vi.doMock('./prompt-context', () => ({
  ...realPromptContext,
  loadShotPromptContext: () =>
    Promise.resolve({
      scene,
      styleConfig,
      characterBible: [],
      locationBible: [],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: DEFAULT_ANALYSIS_MODEL,
      startingFrameImageUrl: null,
      referenceOnly: false,
    }),
}));
vi.doMock('./shot-dialogue', () => ({
  loadShotPromptDialogue: () => Promise.resolve(noLines),
}));
const triggerWorkflow = vi.fn().mockResolvedValue('run-1');
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));

const { loadShotSpecState, regenerateShotPrompt } =
  await import('./regenerate-shot-prompt');

type Source = 'derived' | 'user-edit';

function harness(opts: {
  specHash: string | null;
  hasSpec?: boolean;
  pending?: string | null;
  visual: Source;
  motion: Source;
}) {
  const visualWrites: unknown[] = [];
  const motionWrites: unknown[] = [];
  const visualClaims: unknown[] = [];
  const motionClaims: unknown[] = [];
  const specVersion = {
    id: 'spec-1',
    shotId: 'shot-1',
    spec,
    source: 'analysis',
    inputHash: opts.specHash,
  };
  const scopedDb = {
    shotSpecVersions: {
      getSelected: () =>
        Promise.resolve(opts.hasSpec === false ? null : specVersion),
      stampInputHashIfEmpty: () => Promise.resolve(),
      claim: () => Promise.resolve('spec-claim'),
      clearClaimIf: () => Promise.resolve(),
      getSelectedByShotIds: () => Promise.resolve(new Map()),
    },
    framePromptVersions: {
      getSelected: () =>
        Promise.resolve({
          source: opts.visual,
          inputHash: null,
          specVersionId: 'spec-1',
          createdAt: new Date(0),
        }),
      write: (input: unknown) => {
        visualWrites.push(input);
        return Promise.resolve({});
      },
      createPending: (input: unknown) => {
        visualClaims.push(input);
        return Promise.resolve({ id: 'visual-claim' });
      },
      markGenerating: () => Promise.resolve(),
      markTerminal: () => Promise.resolve(),
    },
    shotPromptVersions: {
      getSelectedMotion: () =>
        Promise.resolve({
          source: opts.motion,
          inputHash: null,
          specVersionId: 'spec-1',
          createdAt: new Date(0),
        }),
      write: (input: unknown) => {
        motionWrites.push(input);
        return Promise.resolve({});
      },
      createPending: (input: unknown) => {
        motionClaims.push(input);
        return Promise.resolve({ id: 'motion-claim' });
      },
      markGenerating: () => Promise.resolve(),
      markTerminal: () => Promise.resolve(),
    },
    characters: { listBibleVersionsBySequence: () => Promise.resolve([]) },
    shots: { listBySequence: () => Promise.resolve([]) },
  };
  const context = {
    shot: {
      id: 'shot-1',
      sceneId: 'scene-1',
      useStartFrame: true,
      pendingSpecVersionId: opts.pending ?? null,
    },
    frame: { id: 'frame-1' },
    sequence: {
      id: 'seq-1',
      generateStartFrames: true,
      aspectRatio: '16:9',
    },
    scopedDb,
    user: { id: 'user-1' },
    teamId: 'team-1',
  };
  return {
    // test stub
    context: asStub<Parameters<typeof regenerateShotPrompt>[0]>(context),
    visualWrites,
    motionWrites,
    visualClaims,
    motionClaims,
  };
}

const keep = { visual: false, motion: false };

describe('loadShotSpecState (#1929)', () => {
  it('reads a spec written from the current script as current', async () => {
    const { context } = harness({
      specHash: currencyHash,
      visual: 'derived',
      motion: 'derived',
    });
    expect((await loadShotSpecState(context, scene)).verdict).toBe('current');
  });

  it('reads a null stamp as current, not a paid rewrite', async () => {
    const { context } = harness({
      specHash: null,
      visual: 'derived',
      motion: 'derived',
    });
    expect((await loadShotSpecState(context, scene)).verdict).toBe('current');
  });

  it('reads a moved script as stale, no spec as missing, a claim as updating', async () => {
    const stale = harness({
      specHash: 'old',
      visual: 'derived',
      motion: 'derived',
    });
    const missing = harness({
      specHash: null,
      hasSpec: false,
      visual: 'derived',
      motion: 'derived',
    });
    const updating = harness({
      specHash: currencyHash,
      pending: 'claim',
      visual: 'derived',
      motion: 'derived',
    });
    expect((await loadShotSpecState(stale.context, scene)).verdict).toBe(
      'stale'
    );
    expect((await loadShotSpecState(missing.context, scene)).verdict).toBe(
      'missing'
    );
    expect((await loadShotSpecState(updating.context, scene)).verdict).toBe(
      'updating'
    );
  });
});

describe('regenerateShotPrompt (#1929)', () => {
  it('rebuilds derived prompts and keeps a written one', async () => {
    const h = harness({
      specHash: currencyHash,
      visual: 'user-edit',
      motion: 'derived',
    });
    const result = await regenerateShotPrompt(h.context, scene, {
      force: true,
      replace: keep,
    });
    expect(result.rebuilt).toBe(true);
    expect(h.visualWrites).toHaveLength(0);
    expect(h.motionWrites).toHaveLength(1);
    expect(h.motionWrites[0]).toMatchObject({
      source: 'derived',
      specVersionId: 'spec-1',
    });
    expect(JSON.stringify(h.motionWrites[0])).toContain(
      'dolly in, then pan left'
    );
  });

  it('replaces a written prompt when the user said so', async () => {
    const h = harness({
      specHash: currencyHash,
      visual: 'user-edit',
      motion: 'user-edit',
    });
    await regenerateShotPrompt(h.context, scene, {
      force: true,
      replace: { visual: true, motion: false },
    });
    expect(h.visualWrites).toHaveLength(1);
    expect(h.motionWrites).toHaveLength(0);
  });

  it('does nothing when every prompt is written and kept', async () => {
    const h = harness({
      specHash: currencyHash,
      visual: 'user-edit',
      motion: 'user-edit',
    });
    const result = await regenerateShotPrompt(h.context, scene, {
      force: true,
      replace: keep,
    });
    expect(result.alreadyUpToDate).toBe(true);
    expect(h.visualWrites).toHaveLength(0);
    expect(h.motionWrites).toHaveLength(0);
  });

  it('rewrites a stale spec, claiming only the prompts it may replace', async () => {
    triggerWorkflow.mockClear();
    const h = harness({
      specHash: 'old',
      visual: 'user-edit',
      motion: 'derived',
    });
    const result = await regenerateShotPrompt(h.context, scene, {
      force: true,
      replace: keep,
    });
    expect(result.workflowRunId).toBe('run-1');
    expect(h.visualClaims).toHaveLength(0);
    expect(h.motionClaims).toHaveLength(1);
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/shot-spec-rewrite',
      expect.objectContaining({
        claimId: 'spec-claim',
        visualClaimId: null,
        motionClaimId: 'motion-claim',
        visualWritten: true,
        motionWritten: false,
        specInputHash: currencyHash,
      })
    );
  });

  it('does not start a second rewrite while one is in flight', async () => {
    const h = harness({
      specHash: currencyHash,
      pending: 'claim',
      visual: 'derived',
      motion: 'derived',
    });
    const result = await regenerateShotPrompt(h.context, scene, {
      force: true,
      replace: keep,
    });
    expect(result.alreadyInFlight).toBe(true);
    expect(h.motionWrites).toHaveLength(0);
  });
});
