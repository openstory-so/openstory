import { describe, expect, it } from 'vitest';
import { dbSceneId } from '@/lib/db/schema';
import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import { deriveShots } from './shot-list.derive';
import type { ShotListPassResult, ShotSpec } from './shot-list.schema';
import type { SceneSplittingScene } from './streaming-scene-parser';
import {
  applyTargetDurations,
  attachShotLists,
  buildSceneWithShots,
  buildShotInserts,
  defaultSingleShot,
  formatScenesForShotListPrompt,
  isSingleShotScene,
  normalizeShots,
  shotDurationMs,
} from './shot-list-pass';

function makeScene(
  n: number,
  extract: string,
  overrides: Partial<SceneSplittingScene> = {}
): SceneSplittingScene {
  return {
    sceneId: `scene_${n}`,
    sceneNumber: n,
    originalScript: { extract, dialogue: [] },
    metadata: {
      title: `Scene ${n}`,
      durationSeconds: 8,
      location: 'INT. HALLWAY - NIGHT',
      timeOfDay: 'night',
      storyBeat: 'rising tension',
    },
    continuity: {
      characterTags: ['sarah'],
      environmentTag: 'dim_hallway',
      elementTags: [],
      colorPalette: 'cold blues',
      lightingSetup: 'single overhead bulb',
      styleTag: 'noir',
    },
    ...overrides,
  };
}

const twoShotSpec = (n: number): ShotSpec => ({
  shotNumber: n,
  framing: {
    shotSize: n === 1 ? 'wide' : 'close-up',
    angle: n === 1 ? 'eye level' : 'low angle',
    composition: n === 1 ? 'doorway' : 'handle',
    subjectStartState:
      n === 1 ? 'Sarah at the door' : "Sarah's hand on the handle",
  },
  action: n === 1 ? 'She opens the door' : 'Cut to the hallway beyond',
  cameraMovement: {
    move: n === 1 ? 'static' : 'push-in',
    pacing: 'slow',
  },
  soundCue: n === 1 ? 'latch click' : 'echo',
  durationSeconds: 4,
});

function firstAttached(
  scenes: ReadonlyArray<SceneSplittingScene>
): SceneSplittingScene {
  const scene = scenes[0];
  if (!scene) throw new Error('expected a scene');
  return scene;
}

describe('normalizeShots', () => {
  it('defaults an empty list to one shot at the scene duration', () => {
    const [shot] = normalizeShots([], 8);
    expect(shot).toEqual(defaultSingleShot(8));
    expect(shot?.shotNumber).toBe(1);
    expect(shot?.durationSeconds).toBe(8);
  });

  it('re-numbers out-of-order specs and caps at MAX_SHOTS_PER_SCENE', () => {
    const shots = [twoShotSpec(2), twoShotSpec(1), twoShotSpec(3)];
    const normalized = normalizeShots(shots, 8);
    expect(normalized.map((s) => s.shotNumber)).toEqual([1, 2, 3]);
  });
});

describe('attachShotLists', () => {
  it('falls back to one shot per scene when the pass is null', () => {
    const scenes = [makeScene(1, 'A man walks in.')];
    const attached = attachShotLists(scenes, null);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.shots).toHaveLength(1);
    expect(isSingleShotScene(firstAttached(attached))).toBe(true);
    expect(attached[0]?.shots?.[0]?.durationSeconds).toBe(8);
  });

  it('attaches two shots to a scene with an internal cut', () => {
    const extract = 'She opens the door. Cut to the hallway beyond.';
    const scenes = [makeScene(1, extract)];
    const pass: ShotListPassResult = {
      scenes: [
        {
          sceneNumber: 1,
          shots: [twoShotSpec(1), twoShotSpec(2)],
        },
      ],
    };
    const scene = firstAttached(attachShotLists(scenes, pass));
    expect(scene.shots).toHaveLength(2);
    expect(scene.shots?.map((s) => s.action)).toEqual([
      'She opens the door',
      'Cut to the hallway beyond',
    ]);
    expect(isSingleShotScene(scene)).toBe(false);
  });

  it('defaults a scene the pass omitted', () => {
    const scenes = [
      makeScene(1, 'First.'),
      makeScene(2, 'Second.', {
        metadata: {
          title: 'Two',
          durationSeconds: 5,
          location: 'EXT. STREET',
          timeOfDay: 'day',
          storyBeat: 'b',
        },
      }),
    ];
    const pass: ShotListPassResult = {
      scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1)] }],
    };
    const attached = attachShotLists(scenes, pass);
    expect(attached[0]?.shots).toHaveLength(1);
    expect(attached[1]?.shots).toHaveLength(1);
    expect(attached[1]?.shots?.[0]?.durationSeconds).toBe(5);
  });
});

describe('applyTargetDurations', () => {
  const seedance = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

  it('is a no-op without a target so existing tests stay identical', () => {
    const attached = attachShotLists([makeScene(1, 'A man walks in.')], null);
    expect(applyTargetDurations(attached, undefined, seedance)).toEqual(
      attached
    );
  });

  it('spreads 30s across five one-shot scenes on the Seedance grid', () => {
    const scenes = [1, 2, 3, 4, 5].map((n) => makeScene(n, `Beat ${n}.`));
    const allocated = applyTargetDurations(
      attachShotLists(scenes, null),
      30,
      seedance
    );
    const seconds = allocated.flatMap(
      (scene) => scene.shots?.map((shot) => shot.durationSeconds) ?? []
    );
    expect(seconds).toEqual([6, 6, 6, 6, 6]);
    expect(allocated[0]?.metadata.durationSeconds).toBe(6);
    const inserts = buildShotInserts(
      'seq-1',
      allocated,
      new Map(allocated.map((_, i) => [i, dbSceneId(`scene-row-${i + 1}`)]))
    );
    expect(inserts.map((row) => row.durationMs)).toEqual([
      6000, 6000, 6000, 6000, 6000,
    ]);
  });

  it('keeps two shots in one scene and still hits 30s across the film', () => {
    const scenes = [
      makeScene(1, 'She opens the door. Cut to the hallway beyond.'),
      makeScene(2, 'She walks on.'),
      makeScene(3, 'She stops.'),
      makeScene(4, 'She smiles.'),
    ];
    const pass: ShotListPassResult = {
      scenes: [
        { sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] },
        { sceneNumber: 2, shots: [twoShotSpec(1)] },
        { sceneNumber: 3, shots: [twoShotSpec(1)] },
        { sceneNumber: 4, shots: [twoShotSpec(1)] },
      ],
    };
    const allocated = applyTargetDurations(
      attachShotLists(scenes, pass),
      30,
      seedance
    );
    const seconds = allocated.flatMap(
      (scene) => scene.shots?.map((shot) => shot.durationSeconds) ?? []
    );
    expect(seconds).toHaveLength(5);
    expect(seconds.reduce((a, b) => a + b, 0)).toBe(30);
    expect(allocated[0]?.shots).toHaveLength(2);
  });
});

describe('buildShotInserts / shotDurationMs', () => {
  it('writes shotNumber 1 at the scene duration for a one-shot scene', () => {
    const scene = firstAttached(
      attachShotLists([makeScene(1, 'A man walks in.')], null)
    );
    const inserts = buildShotInserts(
      'seq-1',
      [scene],
      new Map([[0, dbSceneId('scene-row-1')]])
    );
    expect(inserts).toEqual([
      {
        sequenceId: 'seq-1',
        sceneId: dbSceneId('scene-row-1'),
        shotNumber: 1,
        durationMs: 8000,
      },
    ]);
    const shot = scene.shots?.[0] ?? defaultSingleShot(8);
    expect(shotDurationMs(scene, shot)).toBe(8000);
  });

  it('writes N rows with spec durations for a multi-shot scene', () => {
    const scene = firstAttached(
      attachShotLists([makeScene(1, 'Cut.')], {
        scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] }],
      })
    );
    const inserts = buildShotInserts(
      'seq-1',
      [scene],
      new Map([[0, dbSceneId('scene-row-1')]])
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.map((row) => row.shotNumber)).toEqual([1, 2]);
    expect(inserts.map((row) => row.durationMs)).toEqual([4000, 4000]);
  });
});

describe('formatScenesForShotListPrompt', () => {
  it('numbers slices with title, location, and duration', () => {
    const text = formatScenesForShotListPrompt([
      makeScene(1, 'She opens the door. Cut to the hallway beyond.'),
    ]);
    expect(text).toContain('## Scene 1 — Scene 1');
    expect(text).toContain('INT. HALLWAY - NIGHT');
    expect(text).toContain('duration: 8s');
    expect(text).toContain('She opens the door. Cut to the hallway beyond.');
  });
});

describe('derive from attached shots — acceptance fixture', () => {
  it('two shots share scene continuity and keep their own framing', () => {
    const scene = firstAttached(
      attachShotLists(
        [makeScene(1, 'She opens the door. Cut to the hallway beyond.')],
        {
          scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] }],
        }
      )
    );
    const styleConfig = migrateStyleConfigV1ToV2({
      mood: 'tense',
      artStyle: 'neo-noir cinematic',
      lighting: 'low key',
      colorPalette: ['#111', '#eee'],
      cameraWork: 'handheld',
      referenceFilms: [],
      colorGrading: 'teal and orange',
    });
    const derived = deriveShots(buildSceneWithShots(scene), styleConfig);
    expect(derived).toHaveLength(2);
    for (const shot of derived) {
      expect(shot.visualPrompt.fullPrompt).toContain('INT. HALLWAY - NIGHT');
      expect(shot.visualPrompt.fullPrompt).toContain('single overhead bulb');
    }
    expect(derived[0]?.visualPrompt.fullPrompt).toContain('wide');
    expect(derived[1]?.visualPrompt.fullPrompt).toContain('close-up');
    expect(derived[0]?.motionPrompt.fullPrompt).toContain('She opens the door');
    expect(derived[1]?.motionPrompt.fullPrompt).toContain(
      'Cut to the hallway beyond'
    );
  });
});
