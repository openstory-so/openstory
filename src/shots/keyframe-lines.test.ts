import { describe, expect, it } from 'vitest';
import {
  isKeyframeLine,
  keyframeLines,
  shiftKeyframeLines,
} from './keyframe-lines';
import { deriveMotionPrompt } from './shot-list.derive';
import {
  canonicalStoredShotSpec,
  rescaleKeyframes,
  type StoredShotSpec,
} from './shot-list.schema';
import { attachSceneShots, defaultSingleShot } from './shot-list-pass';

const keyframes = [
  { atSeconds: 0, action: 'MARA drops from the fire escape' },
  { atSeconds: 4, action: 'she rolls across the car roof' },
  { atSeconds: 9, action: 'she hits the ground running' },
];

const spec: StoredShotSpec = {
  framing: { shotSize: '', angle: '', composition: '', subjectStartState: '' },
  action: 'MARA escapes down the alley',
  cameraMovement: { move: 'follow', pacing: 'fast' },
  direction: '',
  soundCue: '',
};

describe('keyframe lines', () => {
  it('writes each keyframe to the next, the last to the end', () => {
    expect(keyframeLines(keyframes)).toEqual([
      '0-4 seconds: MARA drops from the fire escape',
      '4-9 seconds: she rolls across the car roof',
      '9 seconds to the end: she hits the ground running',
    ]);
  });

  it('finds its own lines and nothing else', () => {
    expect(keyframeLines(keyframes).every(isKeyframeLine)).toBe(true);
    expect(isKeyframeLine('MARA escapes. Camera: fast follow')).toBe(false);
    expect(isKeyframeLine('Shot 2 (5-12s): she runs')).toBe(false);
  });

  it('re-times a shot that starts 10s into a packed clip', () => {
    const text = ['She runs.', ...keyframeLines(keyframes)].join('\n');
    expect(shiftKeyframeLines(text, 10, 14)).toBe(
      [
        'She runs.',
        '10-14 seconds: MARA drops from the fire escape',
        '14-19 seconds: she rolls across the car roof',
        '19-24 seconds: she hits the ground running',
      ].join('\n')
    );
  });
});

describe('keyframes on the spec', () => {
  it('puts the lines last in the motion prompt, and none without keyframes', () => {
    const plain = deriveMotionPrompt(spec, { referenceOnly: false }).text;
    expect(plain).not.toContain('\n');
    const timed = deriveMotionPrompt(
      { ...spec, keyframes },
      { referenceOnly: false }
    ).text;
    expect(timed).toBe([plain, ...keyframeLines(keyframes)].join('\n'));
  });

  it('stores no keyframes key when there are none, so old digests hold', () => {
    expect(canonicalStoredShotSpec({ ...spec, keyframes: [] })).toEqual(
      canonicalStoredShotSpec(spec)
    );
    expect('keyframes' in canonicalStoredShotSpec(spec)).toBe(false);
  });

  it('sorts by time and drops blank actions', () => {
    expect(
      canonicalStoredShotSpec({
        ...spec,
        keyframes: [
          { atSeconds: 6, action: 'second' },
          { atSeconds: 3, action: '  ' },
          { atSeconds: 0, action: 'first' },
        ],
      }).keyframes
    ).toEqual([
      { atSeconds: 0, action: 'first' },
      { atSeconds: 6, action: 'second' },
    ]);
  });

  it('moves with the shot when its length changes', () => {
    expect(rescaleKeyframes(keyframes, 10, 20).map((k) => k.atSeconds)).toEqual(
      [0, 8, 18]
    );
  });

  it('is re-timed when the scene label sets the shot length', () => {
    // The pass timed a 10s take; the label gives the lone shot 20s.
    const scene = attachSceneShots(
      {
        sceneId: 's1',
        sceneNumber: 1,
        originalScript: {
          extract: 'Scene 1 — 20s\nMARA escapes.',
          dialogue: [],
        },
        metadata: {
          title: 'Escape',
          durationSeconds: 20,
          location: '',
          timeOfDay: '',
          storyBeat: '',
        },
        continuity: {
          characterTags: [],
          environmentTag: '',
          elementTags: [],
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
        },
      },
      [{ ...defaultSingleShot(10), keyframes }],
      [5, 10, 15, 20, 30]
    );
    expect(scene.shots?.[0]?.durationSeconds).toBe(20);
    expect(scene.shots?.[0]?.keyframes.map((k) => k.atSeconds)).toEqual([
      0, 8, 18,
    ]);
  });
});
