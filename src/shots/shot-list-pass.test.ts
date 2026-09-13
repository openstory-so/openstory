import { describe, expect, it } from 'vitest';
import { dbSceneId } from '@/shots/scene-id';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import { deriveShots } from './shot-list.derive';
import type { ShotListPassResult, ShotSpec } from './shot-list.schema';
import type { SceneSplittingScene } from '@/sequences/server/streaming-scene-parser';
import {
  allocateSceneShots,
  attachShotLists,
  buildSceneWithShots,
  buildShotInserts,
  defaultSingleShot,
  dialogueForShot,
  dialogueFromShots,
  formatCastForShotList,
  formatDirectorStyleForShotList,
  formatScenesForShotListPrompt,
  maxShotsForScene,
  shotDurationMs,
} from './shot-list-pass';

/** Seedance 2.0 clip grid: 4..15s. */
const SEEDANCE = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
/** No video model: no cap, even integer split. */
const NO_GRID: number[] = [];

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
  dialogue:
    n === 1
      ? [{ character: 'Sarah', line: 'Hello?', tone: 'wary' }]
      : [{ character: '', line: ' Come in. ', tone: '' }],
  durationSeconds: 4,
});

function firstAttached(
  scenes: ReadonlyArray<SceneSplittingScene>
): SceneSplittingScene {
  const scene = scenes[0];
  if (!scene) throw new Error('expected a scene');
  return scene;
}

/** A pass covering every scene with one default shot at the scene duration. */
function oneShotEach(
  scenes: ReadonlyArray<SceneSplittingScene>
): ShotListPassResult {
  return {
    scenes: scenes.map((scene) => ({
      sceneNumber: scene.sceneNumber,
      shots: [defaultSingleShot(scene.metadata.durationSeconds)],
    })),
  };
}

describe('maxShotsForScene', () => {
  it('is how many shortest clips fit the label, at least one', () => {
    expect(maxShotsForScene(18, SEEDANCE)).toBe(4);
    expect(maxShotsForScene(5, SEEDANCE)).toBe(1);
    expect(maxShotsForScene(3, SEEDANCE)).toBe(1);
    expect(maxShotsForScene(30, NO_GRID)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('allocateSceneShots (#1593)', () => {
  const scene = (durationSeconds: number, shotLabelSeconds?: number[]) => ({
    metadata: { ...makeScene(1, 'x').metadata, durationSeconds },
    ...(shotLabelSeconds && { shotLabelSeconds }),
  });

  it('defaults an empty list to one shot at the scene duration', () => {
    const [shot] = allocateSceneShots([], scene(8), SEEDANCE);
    expect(shot).toEqual(defaultSingleShot(8));
  });

  it('re-numbers out-of-order specs', () => {
    const shots = [twoShotSpec(2), twoShotSpec(1), twoShotSpec(3)];
    const out = allocateSceneShots(shots, scene(18), SEEDANCE);
    expect(out.map((s) => s.shotNumber)).toEqual([1, 2, 3]);
  });

  it("enhance's shot labels ARE the shots: count and durations verbatim", () => {
    const out = allocateSceneShots(
      [twoShotSpec(1), twoShotSpec(2)],
      scene(10, [4, 6]),
      SEEDANCE
    );
    expect(out.map((s) => s.durationSeconds)).toEqual([4, 6]);
  });

  it('a lone shot takes the whole label, on or off the grid', () => {
    expect(
      allocateSceneShots([twoShotSpec(1)], scene(18), SEEDANCE)[0]
        ?.durationSeconds
    ).toBe(18);
    expect(
      allocateSceneShots([twoShotSpec(1)], scene(3), SEEDANCE)[0]
        ?.durationSeconds
    ).toBe(3);
  });

  it('divides the label across shots on the grid, summing to the label', () => {
    const out = allocateSceneShots(
      [twoShotSpec(1), { ...twoShotSpec(2), durationSeconds: 8 }],
      scene(12),
      SEEDANCE
    );
    expect(out.map((s) => s.durationSeconds)).toEqual([4, 8]);
    expect(out.reduce((sum, s) => sum + s.durationSeconds, 0)).toBe(12);
  });

  it('a label the grid cannot reach exactly lands its residual on the last shot', () => {
    const out = allocateSceneShots(
      [twoShotSpec(1), twoShotSpec(2)],
      scene(12),
      [5, 10]
    );
    expect(out.reduce((sum, s) => sum + s.durationSeconds, 0)).toBe(12);
  });

  it('caps the count at what the label can hold; cut shots hand their lines to the last kept', () => {
    const shots = [1, 2, 3, 4].map((n) => ({
      ...twoShotSpec(2),
      shotNumber: n,
      dialogue: [{ character: 'A', line: `line ${n}`, tone: '' }],
    }));
    // 5s on a 4s-minimum grid: one shot.
    const out = allocateSceneShots(shots, scene(5), SEEDANCE);
    expect(out).toHaveLength(1);
    expect(out[0]?.durationSeconds).toBe(5);
    expect(out[0]?.dialogue.map((l) => l.line)).toEqual([
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ]);
  });

  it('labels that do not match the returned count fall back to dividing the label', () => {
    const out = allocateSceneShots(
      [twoShotSpec(1), twoShotSpec(2), twoShotSpec(3)],
      scene(12, [4, 8]),
      SEEDANCE
    );
    expect(out).toHaveLength(3);
    expect(out.reduce((sum, s) => sum + s.durationSeconds, 0)).toBe(12);
  });

  it('with no grid, splits the label into even integers', () => {
    const out = allocateSceneShots(
      [twoShotSpec(1), twoShotSpec(2), twoShotSpec(3)],
      scene(10),
      NO_GRID
    );
    expect(out.map((s) => s.durationSeconds)).toEqual([4, 3, 3]);
  });
});

describe('attachShotLists', () => {
  it('fails when the pass omits a scene instead of leaving it on the regex preview', () => {
    const scenes = [makeScene(1, 'A man walks in.'), makeScene(2, 'Nobody.')];
    expect(() => attachShotLists(scenes, { scenes: [] }, SEEDANCE)).toThrow(
      /covered 0\/2 scenes; missing scene\(s\) 1, 2/
    );
    expect(() =>
      attachShotLists(
        scenes,
        { scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1)] }] },
        SEEDANCE
      )
    ).toThrow(/missing scene\(s\) 2/);
  });

  it('single default shot from the pass keeps the scene duration', () => {
    const scenes = [makeScene(1, 'A man walks in.')];
    const attached = attachShotLists(scenes, oneShotEach(scenes), SEEDANCE);
    expect(attached[0]?.shots).toHaveLength(1);
    expect(attached[0]?.shots?.[0]?.durationSeconds).toBe(8);
  });

  it('drops the transient shot labels once they have been applied', () => {
    const scenes = [makeScene(1, 'Cut.', { shotLabelSeconds: [4, 4] })];
    const [out] = attachShotLists(
      scenes,
      { scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] }] },
      SEEDANCE
    );
    expect(out?.shots?.map((s) => s.durationSeconds)).toEqual([4, 4]);
    expect(out && 'shotLabelSeconds' in out).toBe(false);
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
    const scene = firstAttached(attachShotLists(scenes, pass, SEEDANCE));
    expect(scene.shots).toHaveLength(2);
    expect(scene.shots?.map((s) => s.action)).toEqual([
      'She opens the door',
      'Cut to the hallway beyond',
    ]);
    // Two shots divide the 8s label: on a 4s-minimum grid that is 4 + 4.
    expect(scene.shots?.map((s) => s.durationSeconds)).toEqual([4, 4]);
  });

  it('a one-shot default from the pass keeps that scene duration', () => {
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
      scenes: [
        { sceneNumber: 1, shots: [twoShotSpec(1)] },
        { sceneNumber: 2, shots: [defaultSingleShot(5)] },
      ],
    };
    const attached = attachShotLists(scenes, pass, SEEDANCE);
    expect(attached[0]?.shots).toHaveLength(1);
    expect(attached[1]?.shots).toHaveLength(1);
    expect(attached[1]?.shots?.[0]?.durationSeconds).toBe(5);
  });
});

describe('attachShotLists — dialogue from shots (#1585)', () => {
  it('lands each line on its shot, trimmed, stamped when the scene has 2+ shots', () => {
    const scene = makeScene(1, 'Sarah at the door.', {
      originalScript: {
        extract: 'Sarah at the door.',
        dialogue: [{ character: 'STALE', line: 'regex preview', tone: '' }],
      },
    });
    const pass: ShotListPassResult = {
      scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] }],
    };
    const [out] = attachShotLists([scene], pass, SEEDANCE);
    expect(out?.originalScript.dialogue).toEqual([
      { character: 'Sarah', line: 'Hello?', tone: 'wary', shotNumber: 1 },
      { character: '', line: 'Come in.', tone: '', shotNumber: 2 },
    ]);
  });

  it('stamps a one-shot scene too and allows an empty list', () => {
    const scene = makeScene(1, 'Sarah at the door.');
    const [talky] = attachShotLists(
      [scene],
      { scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1)] }] },
      SEEDANCE
    );
    expect(talky?.originalScript.dialogue).toEqual([
      { character: 'Sarah', line: 'Hello?', tone: 'wary', shotNumber: 1 },
    ]);
    const [silent] = attachShotLists(
      [scene],
      {
        scenes: [
          { sceneNumber: 1, shots: [{ ...twoShotSpec(1), dialogue: [] }] },
        ],
      },
      SEEDANCE
    );
    expect(silent?.originalScript.dialogue).toEqual([]);
  });

  it('replaces the regex preview even when the pass placed no lines', () => {
    const scene = makeScene(2, 'Nobody home.', {
      originalScript: {
        extract: 'Nobody home.',
        dialogue: [{ character: 'SARAH', line: 'Anyone?', tone: '' }],
      },
    });
    const [out] = attachShotLists(
      [scene],
      {
        scenes: [
          { sceneNumber: 2, shots: [{ ...twoShotSpec(1), dialogue: [] }] },
        ],
      },
      SEEDANCE
    );
    expect(out?.originalScript.dialogue).toEqual([]);
  });

  it('dialogueForShot keeps own + unstamped lines, strips the stamp, drops the rest', () => {
    const lines = [
      { character: 'A', line: 'one', tone: '', shotNumber: 1 },
      { character: 'B', line: 'two', tone: '', shotNumber: 2, voiceToken: 'V' },
      { character: 'C', line: 'any', tone: '' },
      { character: 'D', line: 'gone', tone: '', shotNumber: 9 },
    ];
    expect(dialogueForShot(lines, 2)).toEqual([
      { character: 'B', line: 'two', tone: '', voiceToken: 'V' },
      { character: 'C', line: 'any', tone: '' },
    ]);
    expect(dialogueForShot(lines, 3)).toEqual([
      { character: 'C', line: 'any', tone: '' },
    ]);
    expect(dialogueForShot(undefined, 1)).toEqual([]);
  });

  it('dialogueFromShots drops blank lines', () => {
    expect(
      dialogueFromShots([
        {
          ...twoShotSpec(1),
          dialogue: [{ character: 'A', line: '  ', tone: '' }],
        },
      ])
    ).toEqual([]);
  });
});

describe('formatCastForShotList', () => {
  it('lists every bible name and marks voice-only entries', () => {
    expect(
      formatCastForShotList([
        { name: 'Sarah', voiceOnly: false },
        { name: 'Narrator', voiceOnly: true },
      ])
    ).toBe('- Sarah\n- Narrator (voice only)');
    expect(formatCastForShotList([])).toBe('(none)');
  });
});

describe('film length is the sum of the scene labels (#1593)', () => {
  it('whatever the shot count the pass emits, each scene sums to its label', () => {
    const scenes = [
      makeScene(1, 'She opens the door. Cut to the hallway beyond.'),
      makeScene(2, 'She walks on.', {
        metadata: { ...makeScene(2, '').metadata, durationSeconds: 12 },
      }),
      makeScene(3, 'She stops.', {
        metadata: { ...makeScene(3, '').metadata, durationSeconds: 5 },
      }),
    ];
    const pass: ShotListPassResult = {
      scenes: [
        { sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] },
        {
          sceneNumber: 2,
          shots: [twoShotSpec(1), twoShotSpec(2), twoShotSpec(3)],
        },
        // Asked for two on a 5s scene: a 4s-minimum grid holds one.
        { sceneNumber: 3, shots: [twoShotSpec(1), twoShotSpec(2)] },
      ],
    };
    const attached = attachShotLists(scenes, pass, SEEDANCE);
    const perScene = attached.map((scene) =>
      (scene.shots ?? []).reduce((sum, shot) => sum + shot.durationSeconds, 0)
    );
    expect(perScene).toEqual([8, 12, 5]);
    expect(attached.map((scene) => scene.shots?.length)).toEqual([2, 3, 1]);
    // Scene labels never move.
    expect(attached.map((scene) => scene.metadata.durationSeconds)).toEqual([
      8, 12, 5,
    ]);
    const inserts = buildShotInserts(
      'seq-1',
      attached,
      new Map(attached.map((_, i) => [i, dbSceneId(`scene-row-${i + 1}`)]))
    );
    expect(inserts.reduce((sum, row) => sum + (row.durationMs ?? 0), 0)).toBe(
      25_000
    );
  });
});

describe('buildShotInserts / shotDurationMs', () => {
  it('writes shotNumber 1 at the scene duration for a one-shot scene', () => {
    const scenes = [makeScene(1, 'A man walks in.')];
    const scene = firstAttached(
      attachShotLists(scenes, oneShotEach(scenes), SEEDANCE)
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
    expect(shotDurationMs(shot)).toBe(8000);
  });

  it('writes N rows with allocated durations for a multi-shot scene', () => {
    const scene = firstAttached(
      attachShotLists(
        [makeScene(1, 'Cut.')],
        {
          scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] }],
        },
        SEEDANCE
      )
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

describe('formatDirectorStyleForShotList', () => {
  it('emits mood + camera, and optional coverage refinements', () => {
    const style = migrateStyleConfigV1ToV2({
      mood: 'tense',
      artStyle: 'neo-noir',
      lighting: 'low key',
      colorPalette: ['#111', '#eee'],
      cameraWork: 'handheld, tight lenses',
      referenceFilms: ['Children of Men'],
      colorGrading: 'teal and orange',
    });
    const text = formatDirectorStyleForShotList({
      ...style,
      motion: {
        ...style.motion,
        shots: 'wide establishing, then tight inserts',
        pace: 'brisk',
        energy: 4,
      },
    });
    expect(text).toContain('Mood: tense');
    expect(text).toContain('Camera: handheld, tight lenses');
    expect(text).toContain(
      'Shot selection: wide establishing, then tight inserts'
    );
    expect(text).toContain('Pace: brisk');
    expect(text).toContain('Energy: 4/5');
    expect(text).toContain('References: Children of Men');
    expect(text).not.toContain('neo-noir');
  });

  it('returns empty when no style is snapshotted', () => {
    expect(formatDirectorStyleForShotList(undefined)).toBe('');
  });
});

describe('formatScenesForShotListPrompt', () => {
  it('numbers slices with title, location, duration and shot budget', () => {
    const text = formatScenesForShotListPrompt(
      [makeScene(1, 'She opens the door. Cut to the hallway beyond.')],
      SEEDANCE
    );
    expect(text).toContain('## Scene 1 — Scene 1');
    expect(text).toContain('INT. HALLWAY - NIGHT');
    expect(text).toContain('duration: 8s\nshots: up to 2');
    expect(text).toContain('She opens the door. Cut to the hallway beyond.');
  });

  it('labelled shots are the budget; a label too short for two clips is exactly 1', () => {
    const labelled = formatScenesForShotListPrompt(
      [makeScene(1, 'Cut.', { shotLabelSeconds: [4, 4] })],
      SEEDANCE
    );
    expect(labelled).toContain(
      'shots: exactly 2, as labelled in the script (4s, 4s)'
    );
    const tiny = formatScenesForShotListPrompt(
      [
        makeScene(2, 'Blink.', {
          metadata: { ...makeScene(2, '').metadata, durationSeconds: 5 },
        }),
      ],
      SEEDANCE
    );
    expect(tiny).toContain('duration: 5s\nshots: exactly 1');
    // No grid: no budget line.
    expect(
      formatScenesForShotListPrompt([makeScene(3, 'x')], NO_GRID)
    ).not.toContain('shots:');
  });
});

describe('derive from attached shots — acceptance fixture', () => {
  it('two shots share scene continuity and keep their own framing', () => {
    const scene = firstAttached(
      attachShotLists(
        [makeScene(1, 'She opens the door. Cut to the hallway beyond.')],
        {
          scenes: [{ sceneNumber: 1, shots: [twoShotSpec(1), twoShotSpec(2)] }],
        },
        SEEDANCE
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
