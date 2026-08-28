import { describe, expect, it } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import { deriveMotionPrompt, deriveShots } from './shot-list.derive';
import type { SceneWithShots } from './shot-list.schema';

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
        soundCue: 'distant hum, footsteps',
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
        soundCue: 'handle click, hinge creak',
        durationSeconds: 6,
      },
    ],
    ...overrides,
  };
}

/** First shot of a scene, with a guard so tests never need a `!` assertion. */
function firstShot(scene: SceneWithShots) {
  const [shot] = scene.shots;
  if (!shot) throw new Error('test scene has no shots');
  return shot;
}

describe('deriveShots — single source of truth', () => {
  it('produces one derived shot per shot, ordered by shotNumber', () => {
    const scene = makeScene();
    const derived = deriveShots(scene, styleConfig);
    expect(derived).toHaveLength(2);
    expect(derived.map((d) => d.shotNumber)).toEqual([1, 2]);
  });

  it('reuses scene context verbatim across every shot (no per-shot re-derivation)', () => {
    const derived = deriveShots(makeScene(), styleConfig);
    for (const d of derived) {
      const visual = d.visualPrompt.fullPrompt;
      // Scene-level shared truth appears in EVERY shot's visual prompt.
      expect(visual).toContain('INT. HALLWAY - NIGHT');
      expect(visual).toContain('dim_hallway');
      expect(visual).toContain('single overhead bulb');
      expect(visual).toContain('cold blues');
      expect(visual).toContain('neo-noir cinematic');
    }
  });

  it('composes start-frame visual from shot framing + scene context', () => {
    const [first] = deriveShots(makeScene(), styleConfig);
    const visual = first?.visualPrompt;
    expect(visual?.fullPrompt).toContain('wide');
    expect(visual?.fullPrompt).toContain('eye level');
    expect(visual?.fullPrompt).toContain('Sarah at the far end');
    expect(visual?.fullPrompt).toContain('single overhead bulb');
  });

  it('composes motion prompt from action + one camera move + sound cue', () => {
    const [, second] = deriveShots(makeScene(), styleConfig);
    const motion = second?.motionPrompt;
    expect(motion?.fullPrompt).toContain('she turns the handle and pushes');
    expect(motion?.fullPrompt).toContain('gradual push-in');
    // Sound cue is carried into the audio channel for audio-capable models.
    expect(motion?.audio?.ambientSound).toBe('handle click, hinge creak');
  });

  it('carries per-shot duration as durationMs', () => {
    const derived = deriveShots(makeScene(), styleConfig);
    expect(derived[0]?.durationMs).toBe(6000);
  });

  it('copies no scene context onto the shot — it resolves through sceneId', () => {
    const [first] = deriveShots(makeScene(), styleConfig);
    expect(first).not.toHaveProperty('metadata');
  });
});

describe('deriveMotionPrompt — model-agnostic', () => {
  it('emits no vendor-specific syntax (no Seedance/Kling/Veo tokens)', () => {
    const scene = makeScene();
    for (const shot of scene.shots) {
      const motion = deriveMotionPrompt(scene, shot);
      const text = JSON.stringify(motion).toLowerCase();
      for (const vendor of [
        'seedance',
        'kling',
        'veo',
        'bytedance',
        '--',
        '[camera]',
      ]) {
        expect(text).not.toContain(vendor);
      }
    }
  });

  it('signals dialogue presence and omits it when the scene is silent', () => {
    const silent = makeScene({ dialoguePresent: false });
    const motion = deriveMotionPrompt(silent, firstShot(silent));
    expect(motion.dialogue).toBeNull();

    const spoken = makeScene({ dialoguePresent: true });
    const m2 = deriveMotionPrompt(spoken, firstShot(spoken));
    expect(m2.dialogue?.presence).toBe(true);
    expect(m2.dialogue?.lines).toHaveLength(1);
  });

  it('omits audio when there is no sound cue', () => {
    const scene = makeScene();
    const shot = { ...firstShot(scene), soundCue: '' };
    const motion = deriveMotionPrompt(scene, shot);
    expect(motion.audio).toBeNull();
  });
});

describe('deriveShots — single-shot regression', () => {
  it('returns exactly one derived shot for a short single-shot scene', () => {
    const scene = makeScene({
      metadata: {
        title: 'Establishing',
        durationSeconds: 4,
        location: 'EXT. CITY - DAY',
        timeOfDay: 'day',
        storyBeat: 'opening',
      },
      shots: [
        {
          shotNumber: 1,
          framing: {
            shotSize: 'extreme wide',
            angle: 'high angle',
            composition: 'skyline fills the frame',
            subjectStartState: 'static cityscape',
          },
          action: 'clouds drift over the towers',
          cameraMovement: { move: 'static', pacing: 'slow' },
          soundCue: 'city ambience',
          durationSeconds: 4,
        },
      ],
    });
    const derived = deriveShots(scene, styleConfig);
    expect(derived).toHaveLength(1);
    expect(derived[0]?.motionPrompt.fullPrompt).toContain('slow static');
  });
});
