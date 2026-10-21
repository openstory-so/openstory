import { describe, expect, it } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import type { StyleConfig } from '@/platform/server/db/schema/libraries';
import { deriveMotionPrompt, deriveStillPrompt } from './shot-list.derive';
import {
  storedShotSpec,
  type SceneWithShots,
  type ShotSpec,
} from './shot-list.schema';

const styleConfig: StyleConfig = migrateStyleConfigV1ToV2({
  mood: 'tense',
  artStyle: 'neo-noir cinematic',
  lighting: 'low key',
  colorPalette: ['#111', '#eee'],
  cameraWork: 'handheld',
  referenceFilms: ['Blade Runner'],
  colorGrading: 'teal and orange',
});

function makeScene(overrides: Partial<SceneWithShots> = {}): SceneWithShots {
  return {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: {
      extract: 'She opens the door.',
      dialogue: [{ character: 'SARAH', line: 'Hello?', tone: 'wary' }],
    },
    metadata: {
      title: 'The Doorway',
      durationSeconds: 12,
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
    dialoguePresent: true,
    continuousFromPrevious: false,
    shots: [
      {
        shotNumber: 1,
        framing: {
          shotSize: 'wide',
          angle: 'eye level',
          composition: 'centered down the hallway',
          subjectStartState: 'Sarah at the far end, hand on the wall',
        },
        action: 'Sarah walks toward the door',
        cameraMovement: { move: 'dolly', pacing: 'slow' },
        direction: '',
        soundCue: 'distant hum, footsteps',
        dialogue: [],
        durationSeconds: 6,
      },
      {
        shotNumber: 2,
        framing: {
          shotSize: 'close-up',
          angle: 'low angle',
          composition: 'hand on the door handle, shallow depth',
          subjectStartState: "Sarah's fingers wrapping the handle",
        },
        action: 'she turns the handle and pushes',
        cameraMovement: { move: 'push-in', pacing: 'gradual' },
        direction: '',
        soundCue: 'handle click, hinge creak',
        dialogue: [],
        durationSeconds: 6,
      },
    ],
    ...overrides,
  };
}

/** Shot N of a scene, with a guard so tests never need a `!` assertion. */
function shot(scene: SceneWithShots, n = 1): ShotSpec {
  const found = scene.shots.find((s) => s.shotNumber === n);
  if (!found) throw new Error(`test scene has no shot ${n}`);
  return found;
}

const still = (scene: SceneWithShots, n = 1) =>
  deriveStillPrompt(storedShotSpec(shot(scene, n)), scene, styleConfig);
const motion = (scene: SceneWithShots, n = 1, referenceOnly = false) =>
  deriveMotionPrompt(storedShotSpec(shot(scene, n)), { referenceOnly });

describe('deriveStillPrompt', () => {
  it('does not put later arrivals into an earlier participant close-up', () => {
    const scene = makeScene();
    scene.continuity.characterTags = ['sarah', 'finn', 'ravi'];
    scene.continuity.environmentTag = 'sarah_study, finn_office, ravi_kitchen';
    scene.metadata.location = 'Sarah study / Finn office / Ravi kitchen';
    scene.originalScript.extract =
      'Sarah talks to Finn on a video call. Ravi joins later.';
    const earlier = shot(scene);
    scene.shots = [
      earlier,
      {
        ...earlier,
        shotNumber: 2,
        framing: {
          ...earlier.framing,
          subjectStartState: 'Ravi waves from his webcam',
        },
      },
    ];

    expect(still(scene, 1)).toContain('Sarah');
    expect(still(scene, 1)).not.toMatch(/ravi|finn/i);
    expect(still(scene, 2)).toContain('Ravi');
    expect(still(scene, 2)).not.toMatch(/sarah|finn/i);
  });

  it('reuses scene context verbatim across every shot', () => {
    const scene = makeScene();
    for (const n of [1, 2]) {
      const text = still(scene, n);
      expect(text).toContain('INT. HALLWAY - NIGHT');
      expect(text).toContain('dim_hallway');
      expect(text).toContain('single overhead bulb');
      expect(text).toContain('cold blues');
      expect(text).toContain('neo-noir cinematic');
    }
  });

  it('opens with the shot framing', () => {
    expect(still(makeScene())).toBe(
      'wide, eye level, Sarah at the far end, hand on the wall, centered down the hallway, INT. HALLWAY - NIGHT, night, dim_hallway, single overhead bulb, cold blues, neo-noir cinematic, teal and orange'
    );
  });
});

describe('deriveMotionPrompt', () => {
  it('composes action + camera move, with the sound cue as audio', () => {
    const { text, audio } = motion(makeScene(), 2);
    expect(text).toBe(
      'she turns the handle and pushes. Camera: gradual push-in'
    );
    expect(audio).toEqual({
      ambientSound: 'handle click, hinge creak',
      soundEffects: [],
    });
  });

  it('keeps a chained move and a free pacing intact (#1915)', () => {
    const scene = makeScene();
    scene.shots[0] = {
      ...shot(scene),
      cameraMovement: {
        move: 'arc around the actor, then follow as she runs',
        pacing: 'accelerating into the turn',
      },
      direction: 'let her hesitate before she runs',
    };
    expect(motion(scene).text).toBe(
      'Sarah walks toward the door. let her hesitate before she runs. Camera: accelerating into the turn arc around the actor, then follow as she runs'
    );
  });

  it('emits no vendor-specific syntax', () => {
    const scene = makeScene();
    for (const n of [1, 2]) {
      const text = JSON.stringify(motion(scene, n)).toLowerCase();
      for (const vendor of ['seedance', 'kling', 'veo', 'bytedance', '--']) {
        expect(text).not.toContain(vendor);
      }
    }
  });

  it('empties audio when there is no sound cue', () => {
    const scene = makeScene();
    scene.shots[0] = { ...shot(scene), soundCue: '' };
    expect(motion(scene).audio).toEqual({ ambientSound: '', soundEffects: [] });
  });

  it('reference-only prefixes unique framing, not scene lighting/palette/look', () => {
    const { text } = motion(makeScene(), 1, true);
    expect(text).toBe(
      'wide, eye level, Sarah at the far end, hand on the wall, centered down the hallway. Sarah walks toward the door. Camera: slow dolly'
    );
  });
});
