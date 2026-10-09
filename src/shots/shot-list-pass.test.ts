import { describe, expect, it } from 'vitest';
import { dbSceneId } from '@/shots/scene-id';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import { deriveMotionPrompt, deriveStillPrompt } from './shot-list.derive';
import {
  storedShotSpec,
  type ShotListPassResult,
  type ShotSpec,
} from './shot-list.schema';
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
  minShotsForScene,
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
  direction: '',
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
  it('is how many editorial seconds fit the label, at least one', () => {
    expect(maxShotsForScene(18, SEEDANCE)).toBe(18);
    expect(maxShotsForScene(5, SEEDANCE)).toBe(5);
    expect(maxShotsForScene(3, SEEDANCE)).toBe(3);
    expect(maxShotsForScene(30, NO_GRID)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('minShotsForScene', () => {
  it('is how many longest clips the label needs, at least one', () => {
    expect(minShotsForScene(993, SEEDANCE)).toBe(67);
    expect(minShotsForScene(18, SEEDANCE)).toBe(2);
    expect(minShotsForScene(5, SEEDANCE)).toBe(1);
    expect(minShotsForScene(30, NO_GRID)).toBe(1);
  });
});

describe('allocateSceneShots (#1593, #1621)', () => {
  const scene = (durationSeconds: number) => ({
    metadata: { ...makeScene(1, 'x').metadata, durationSeconds },
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

  it('a lone shot takes the whole label, up to the longest clip', () => {
    expect(
      allocateSceneShots([twoShotSpec(1)], scene(12), SEEDANCE)[0]
        ?.durationSeconds
    ).toBe(12);
    expect(
      allocateSceneShots([twoShotSpec(1)], scene(18), SEEDANCE)[0]
        ?.durationSeconds
    ).toBe(15);
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

  it('too few shots for the label leave the scene short, never a shot past the longest clip', () => {
    const out = allocateSceneShots(
      [1, 2, 3].map((n) => ({ ...twoShotSpec(n), shotNumber: n })),
      scene(993),
      SEEDANCE
    );
    expect(out.map((s) => s.durationSeconds)).toEqual([15, 15, 15]);
  });

  it('keeps more shots than the model min when they still fit the label', () => {
    const shots = [1, 2, 3, 4].map((n) => ({
      ...twoShotSpec(2),
      shotNumber: n,
      dialogue: [{ character: 'A', line: `line ${n}`, tone: '' }],
    }));
    // 5s used to cap at one 4s-min clip. Editorial 1s shots keep all four.
    const out = allocateSceneShots(shots, scene(5), SEEDANCE);
    expect(out).toHaveLength(4);
    expect(out.reduce((sum, s) => sum + s.durationSeconds, 0)).toBe(5);
    expect(out.flatMap((s) => s.dialogue.map((l) => l.line))).toEqual([
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ]);
  });

  it('splits a shot holding more speech than the longest clip, between lines (#1657)', () => {
    // 15s longest clip → 30 words. Five 12-word lines → 2 + 2 + 1.
    const line = (n: number) => ({
      character: 'ELARA',
      line: `line ${n} ${'word '.repeat(10).trim()}`,
      tone: '',
    });
    const lines = [1, 2, 3, 4, 5].map(line);
    const out = allocateSceneShots(
      [twoShotSpec(1), { ...twoShotSpec(2), dialogue: lines }],
      scene(60),
      SEEDANCE
    );
    expect(out.map((s) => s.shotNumber)).toEqual([1, 2, 3, 4]);
    expect(out.slice(1).map((s) => s.dialogue.length)).toEqual([2, 2, 1]);
    expect(out.slice(1).flatMap((s) => s.dialogue)).toEqual(lines);
    expect(out[2]?.framing).toEqual(out[1]?.framing);
    expect(out.reduce((sum, s) => sum + s.durationSeconds, 0)).toBe(60);
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
    // No Scene N label: the model's 4s + 4s are kept, not stretched to the
    // 8s word-count ceiling on the scene.
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

  it('keeps the model seconds on an unlabelled scene instead of the word-count ceiling (#2077)', () => {
    const extract = [
      'INT. KITCHEN - NIGHT',
      'Sarah fills the kettle and watches rain streak the dark window, the street below empty, the clock over the stove stuck.',
      '',
      'SARAH',
      'Tea?',
      '',
      'JOHN',
      'Please.',
    ].join('\n');
    const scene = makeScene(1, extract, {
      metadata: { ...makeScene(1, '').metadata, durationSeconds: 40 },
    });
    const [attached] = attachShotLists(
      [scene],
      {
        scenes: [
          {
            sceneNumber: 1,
            shots: [{ ...twoShotSpec(1), durationSeconds: 4 }],
          },
        ],
      },
      SEEDANCE
    );
    expect(attached?.shots?.map((shot) => shot.durationSeconds)).toEqual([4]);
    expect(attached?.metadata.durationSeconds).toBe(4);
    const words = extract.split(/\s+/).filter(Boolean).length;
    expect(attached?.metadata.durationSeconds).toBeLessThan(
      Math.round(words / 3)
    );
  });

  it('raises an unlabelled shot until its lines fit, within the longest clip (#2077)', () => {
    const scene = makeScene(1, 'INT. KITCHEN - NIGHT\nSarah talks.', {
      metadata: { ...makeScene(1, '').metadata, durationSeconds: 40 },
    });
    const [attached] = attachShotLists(
      [scene],
      {
        scenes: [
          {
            sceneNumber: 1,
            shots: [
              {
                ...twoShotSpec(1),
                durationSeconds: 4,
                dialogue: [
                  {
                    character: 'SARAH',
                    line: 'word '.repeat(20).trim(),
                    tone: '',
                  },
                ],
              },
            ],
          },
        ],
      },
      SEEDANCE
    );
    // 20 words at 2 words a second. The model's 4s is below that, and 10s
    // is under both the 15s clip and the 40s ceiling.
    expect(attached?.shots?.map((shot) => shot.durationSeconds)).toEqual([10]);
    expect(attached?.metadata.durationSeconds).toBe(10);
  });

  it('splits an overfull unlabelled shot and gives each piece its lines (#2077)', () => {
    const line = (n: number) => ({
      character: 'SARAH',
      line: `line ${n} ${'word '.repeat(9).trim()}`,
      tone: '',
    });
    const scene = makeScene(1, 'INT. KITCHEN - NIGHT\nSarah talks.');
    const [attached] = attachShotLists(
      [scene],
      {
        scenes: [
          {
            sceneNumber: 1,
            shots: [
              {
                ...twoShotSpec(1),
                durationSeconds: 6,
                dialogue: [1, 2, 3, 4].map(line),
              },
            ],
          },
        ],
      },
      SEEDANCE
    );
    // Two groups of 22 words. The parent's 6s is not shared (that would be
    // 3s + 3s) and not counted twice (12s). Each piece is 11s, which the
    // 8s word-count ceiling does not pull back down.
    const seconds = attached?.shots?.map((shot) => shot.durationSeconds) ?? [];
    expect(seconds).toEqual([11, 11]);
    expect(attached?.metadata.durationSeconds).toBe(22);
  });

  it('drops unlabelled shots past the word-count ceiling and caps their sum (#2077)', () => {
    const silent = (n: number, seconds: number): ShotSpec => ({
      ...twoShotSpec(n),
      dialogue: [],
      durationSeconds: seconds,
    });
    const scene = makeScene(1, 'INT. KITCHEN - NIGHT\nSarah waits.', {
      metadata: { ...makeScene(1, '').metadata, durationSeconds: 3 },
    });
    const [attached] = attachShotLists(
      [scene],
      {
        scenes: [
          {
            sceneNumber: 1,
            shots: [1, 2, 3, 4, 5].map((n) => silent(n, 15)),
          },
        ],
      },
      SEEDANCE
    );
    const seconds = attached?.shots?.map((shot) => shot.durationSeconds) ?? [];
    expect(seconds).toEqual([1, 1, 1]);
    expect(attached?.metadata.durationSeconds).toBe(3);
  });

  it('pulls a long unlabelled sum down to the word-count ceiling (#2077)', () => {
    const silent = (n: number, seconds: number): ShotSpec => ({
      ...twoShotSpec(n),
      dialogue: [],
      durationSeconds: seconds,
    });
    const scene = makeScene(1, 'INT. KITCHEN - NIGHT\nSarah waits.', {
      metadata: { ...makeScene(1, '').metadata, durationSeconds: 8 },
    });
    const [attached] = attachShotLists(
      [scene],
      {
        scenes: [{ sceneNumber: 1, shots: [silent(1, 15), silent(2, 15)] }],
      },
      SEEDANCE
    );
    expect(attached?.shots?.map((shot) => shot.durationSeconds)).toEqual([
      4, 4,
    ]);
    expect(attached?.metadata.durationSeconds).toBe(8);
  });

  it('caps one unlabelled shot at the longest clip, under the word-count ceiling (#2077)', () => {
    const scene = makeScene(1, 'INT. KITCHEN - NIGHT\nSarah waits.', {
      metadata: { ...makeScene(1, '').metadata, durationSeconds: 40 },
    });
    const [attached] = attachShotLists(
      [scene],
      {
        scenes: [
          {
            sceneNumber: 1,
            shots: [{ ...twoShotSpec(1), dialogue: [], durationSeconds: 100 }],
          },
        ],
      },
      SEEDANCE
    );
    expect(attached?.shots?.map((shot) => shot.durationSeconds)).toEqual([15]);
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
      makeScene(
        1,
        'Scene 1 — 8s\nShe opens the door. Cut to the hallway beyond.'
      ),
      makeScene(2, 'Scene 2 — 12s\nShe walks on.', {
        metadata: { ...makeScene(2, '').metadata, durationSeconds: 12 },
      }),
      makeScene(3, 'Scene 3 — 5s\nShe stops.', {
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
        // Asked for two on a 5s scene: editorial 1s shots keep both.
        { sceneNumber: 3, shots: [twoShotSpec(1), twoShotSpec(2)] },
      ],
    };
    const attached = attachShotLists(scenes, pass, SEEDANCE);
    const perScene = attached.map((scene) =>
      (scene.shots ?? []).reduce((sum, shot) => sum + shot.durationSeconds, 0)
    );
    expect(perScene).toEqual([8, 12, 5]);
    expect(attached.map((scene) => scene.shots?.length)).toEqual([2, 3, 2]);
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
      [
        makeScene(
          1,
          'Scene 1 — 8s\nShe opens the door. Cut to the hallway beyond.'
        ),
      ],
      SEEDANCE
    );
    expect(text).toContain('## Scene 1 — Scene 1');
    expect(text).toContain('INT. HALLWAY - NIGHT');
    expect(text).toContain('duration: 8s\nshots: up to 8');
    expect(text).toContain('She opens the door. Cut to the hallway beyond.');
  });

  it('a short label still allows inserts; a very long one needs a floor', () => {
    const tiny = formatScenesForShotListPrompt(
      [
        makeScene(2, 'Scene 2 — 5s\nBlink.', {
          metadata: { ...makeScene(2, '').metadata, durationSeconds: 5 },
        }),
      ],
      SEEDANCE
    );
    expect(tiny).toContain('duration: 5s\nshots: up to 5');
    // 993s on a 15s max clip needs 67 clips; editorial 1s holds 993.
    const long = formatScenesForShotListPrompt(
      [
        makeScene(4, 'Scene 4 — 993s\nSiege.', {
          metadata: { ...makeScene(4, '').metadata, durationSeconds: 993 },
        }),
      ],
      SEEDANCE
    );
    expect(long).toContain('duration: 993s\nshots: 67 to 993');
    // No grid: no budget line.
    expect(
      formatScenesForShotListPrompt([makeScene(3, 'x')], NO_GRID)
    ).not.toContain('shots:');
  });

  it('omits the duration total when the slice has no Scene N label (#2077)', () => {
    const text = formatScenesForShotListPrompt(
      [
        makeScene(
          1,
          'INT. KITCHEN - NIGHT\nSarah fills the kettle.\nSARAH\nTea?'
        ),
      ],
      SEEDANCE
    );
    expect(text).not.toContain('duration:');
    expect(text).toContain('shots: up to 8');
    expect(text).not.toContain('shots: 1 to');
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
    const built = buildSceneWithShots(scene);
    expect(built.shots).toHaveLength(2);
    const stills = built.shots.map((spec) =>
      deriveStillPrompt(storedShotSpec(spec), built, styleConfig)
    );
    const motions = built.shots.map(
      (spec) =>
        deriveMotionPrompt(storedShotSpec(spec), { referenceOnly: false }).text
    );
    for (const still of stills) {
      expect(still).toContain('INT. HALLWAY - NIGHT');
      expect(still).toContain('single overhead bulb');
    }
    expect(stills[0]).toContain('wide');
    expect(stills[1]).toContain('close-up');
    expect(motions[0]).toContain('She opens the door');
    expect(motions[1]).toContain('Cut to the hallway beyond');
  });
});
