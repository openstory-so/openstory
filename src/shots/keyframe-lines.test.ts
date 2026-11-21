import { describe, expect, it } from 'vitest';
import {
  isKeyframeLine,
  keyframeLines,
  shiftKeyframeLines,
} from './keyframe-lines';
import { deriveMotionPrompt } from './shot-list.derive';
import {
  canonicalStoredShotSpec,
  keyframeFault,
  keyframesWithin,
  rescaleKeyframes,
  type StoredShotSpec,
} from './shot-list.schema';
import { attachSceneShots, defaultSingleShot } from './shot-list-pass';
import {
  buildMotionShotPrompt,
  buildPackedMotionPrompt,
} from '@/motion/server/build-motion-prompts';

const keyframes = [
  { atSeconds: 0, action: 'MARA drops from the fire escape', camera: '' },
  {
    atSeconds: 4,
    action: 'she rolls across the car roof.',
    camera: 'low beside the car',
  },
  { atSeconds: 9, action: 'she hits the ground running', camera: '' },
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
      '4-9 seconds: continuing in the same shot, she rolls across the car roof. Camera: low beside the car',
      '9 seconds to the end: continuing in the same shot, she hits the ground running',
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
        '14-19 seconds: continuing in the same shot, she rolls across the car roof. Camera: low beside the car',
        '19-24 seconds: continuing in the same shot, she hits the ground running',
      ].join('\n')
    );
  });
});

describe('a keyframed shot in a packed clip', () => {
  it('counts its lines from the clip start', () => {
    const { prompt } = buildPackedMotionPrompt({
      model: 'seedance_v2_5',
      shots: [
        { durationSeconds: 5, prompt: 'She waits.' },
        {
          durationSeconds: 10,
          prompt: ['She runs.', ...keyframeLines(keyframes)].join('\n'),
        },
      ],
    });
    expect(prompt).toContain('Shot 2 (5-15s): She runs.');
    expect(prompt).toContain('5-9 seconds: MARA drops');
    expect(prompt).toContain('14-15 seconds: continuing in the same shot,');
  });

  it('drops the one-take pin: the clip has other shots', () => {
    const { prompt } = buildPackedMotionPrompt({
      model: 'seedance_v2_5',
      shots: [
        { durationSeconds: 5, prompt: 'She waits.' },
        {
          durationSeconds: 10,
          prompt: deriveMotionPrompt(
            { ...spec, keyframes },
            { referenceOnly: false }
          ).text,
        },
      ],
    });
    expect(prompt).not.toContain('no cuts');
    expect(prompt).toContain('Shot 2 (5-15s): Camera: follow, fast.');
  });
});

describe('keyframes on the spec', () => {
  it('opens a keyframed take with the take and camera, lines last', () => {
    const plain = deriveMotionPrompt(spec, { referenceOnly: false }).text;
    expect(plain).toBe('MARA escapes down the alley. Camera: fast follow');
    const timed = deriveMotionPrompt(
      { ...spec, keyframes },
      { referenceOnly: false }
    ).text;
    expect(timed).toBe(
      [
        'One continuous shot, no cuts. Camera: follow, fast. MARA escapes down the alley',
        ...keyframeLines(keyframes),
      ].join('\n')
    );
  });

  it('joins prose fields without doubled stops, and labels the opening frame', () => {
    const timed = deriveMotionPrompt(
      {
        ...spec,
        framing: {
          shotSize: 'wide',
          angle: 'low angle',
          subjectStartState: 'MARA on the lower landing, looking up.',
          composition: 'The fire escape zigzagging up the wall.',
        },
        action: 'MARA climbs the fire escape.',
        cameraMovement: {
          move: 'Crane up the wall following MARA.',
          pacing: 'Steady, climbing with her',
        },
        keyframes,
      },
      { referenceOnly: true }
    ).text;
    expect(timed.split('\n')[0]).toBe(
      'One continuous shot, no cuts. Camera: Crane up the wall following MARA, steady, climbing with her. MARA climbs the fire escape. Opening frame: wide, low angle, MARA on the lower landing, looking up, The fire escape zigzagging up the wall'
    );
  });

  it('says the one-take pin once on Seedance', () => {
    const text = deriveMotionPrompt(
      { ...spec, keyframes },
      { referenceOnly: false }
    ).text;
    const prompt = buildMotionShotPrompt({
      motionPrompt: { fullPrompt: text },
      model: 'seedance_v2_5',
    });
    expect(prompt.match(/no cuts/g)).toHaveLength(1);
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
          { atSeconds: 6, action: 'second', camera: '' },
          { atSeconds: 3, action: '  ', camera: '' },
          { atSeconds: 0, action: 'first', camera: ' wide ' },
        ],
      }).keyframes
    ).toEqual([
      { atSeconds: 0, action: 'first', camera: 'wide' },
      { atSeconds: 6, action: 'second', camera: '' },
    ]);
  });

  it('moves with the shot when its length changes', () => {
    expect(rescaleKeyframes(keyframes, 10, 20).map((k) => k.atSeconds)).toEqual(
      [0, 8, 18]
    );
  });

  it("refuses a keyframe past the end or on another's second", () => {
    expect(keyframeFault(keyframes, 10)).toBeNull();
    expect(keyframeFault(keyframes, 9)).toBe(
      'Keyframe at 9s is past the end of this 9s shot'
    );
    expect(
      keyframeFault(
        [...keyframes, { atSeconds: 4, action: 'again', camera: '' }],
        10
      )
    ).toBe('Two keyframes start at 4s');
  });

  it('keeps the first keyframe at each second when a cut shot collides', () => {
    // 0, 4, 9 on a 10s take cut to 2s land at 0, 1, 2.
    expect(
      keyframesWithin(rescaleKeyframes(keyframes, 10, 2), 2).map(
        (k) => k.atSeconds
      )
    ).toEqual([0, 1]);
    const close = [0, 2, 4].map((atSeconds) => ({
      atSeconds,
      action: 'a',
      camera: '',
    }));
    expect(
      keyframesWithin(rescaleKeyframes(close, 10, 3), 3).map((k) => k.atSeconds)
    ).toEqual([0, 1]);
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
