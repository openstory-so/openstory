import { describe, expect, it } from 'vitest';
import { REFERENCE_LIKENESS_INSTRUCTION } from '@/cast/character-prompt';
import {
  buildPreviewPrompt,
  previewTextForShot,
  type PreviewCharacter,
  type PreviewShotScene,
} from './poster-prompt';

const NO_CAMERA = { move: '', pacing: '' };

function character(
  overrides: Partial<PreviewCharacter> = {}
): PreviewCharacter {
  return {
    name: 'Mina',
    age: '30s',
    gender: 'Female',
    physicalDescription: 'Tall, cropped silver hair.',
    standardClothing: 'a long grey coat',
    voiceOnly: false,
    ...overrides,
  };
}

function scene(overrides: Partial<PreviewShotScene> = {}): PreviewShotScene {
  return {
    originalScript: { extract: 'The whole scene as a screenplay slice.' },
    metadata: {
      title: 'The hallway',
      location: 'Apartment hallway',
      timeOfDay: 'morning',
    },
    shots: [
      {
        shotNumber: 1,
        framing: {
          shotSize: 'medium close-up',
          angle: 'eye level',
          composition: 'She fills the right third, doorway left.',
          subjectStartState: 'She stands at the door, hand on the frame.',
        },
        action: 'She opens the door.',
        cameraMovement: { move: 'push-in', pacing: 'slow' },
        direction: 'Hesitant, as if listening.',
      },
    ],
    ...overrides,
  };
}

describe('previewTextForShot', () => {
  it('uses the shot spec even when the scene has only one shot', () => {
    const text = previewTextForShot(scene(), 1);
    expect(text).toContain('medium close-up');
    expect(text).toContain('She fills the right third, doorway left');
    expect(text).toContain('She stands at the door, hand on the frame');
    expect(text).toContain('Then: She opens the door');
    expect(text).toContain('Camera: push-in, slow');
    expect(text).toContain('Hesitant, as if listening');
    expect(text).not.toContain('Apartment hallway');
    expect(text).not.toContain('screenplay slice');
  });

  it('picks the matching shot in a multi-shot scene', () => {
    const text = previewTextForShot(
      scene({
        shots: [
          {
            shotNumber: 1,
            framing: {
              shotSize: 'wide',
              angle: 'eye level',
              composition: 'hallway receding',
              subjectStartState: 'she is at the far end',
            },
            action: 'She walks toward camera.',
            cameraMovement: NO_CAMERA,
            direction: '',
          },
          {
            shotNumber: 2,
            framing: {
              shotSize: 'close-up',
              angle: 'slightly above',
              composition: 'hand on the knob, centered',
              subjectStartState: 'her hand rests on the knob',
            },
            action: 'Cut to the hallway beyond',
            cameraMovement: NO_CAMERA,
            direction: '',
          },
        ],
      }),
      2
    );
    expect(text).toContain('Cut to the hallway beyond');
    expect(text).toContain('hand on the knob, centered');
    expect(text).not.toContain('She walks toward camera');
  });

  it('falls back to the scene slice when the spec is empty', () => {
    expect(
      previewTextForShot(
        scene({
          shots: [
            {
              shotNumber: 1,
              framing: {
                shotSize: '',
                angle: '',
                composition: '',
                subjectStartState: '',
              },
              action: '',
              cameraMovement: NO_CAMERA,
              direction: '',
            },
          ],
          metadata: {
            title: 'The hallway',
            location: '',
            timeOfDay: '',
          },
        }),
        1
      )
    ).toBe('The whole scene as a screenplay slice.');
  });

  it('does not glue trailing periods into double dots', () => {
    const text = previewTextForShot(scene(), 1);
    expect(text).not.toContain('..');
  });

  it('does not append scene location or time of day', () => {
    const text = previewTextForShot(scene(), 1);
    expect(text).not.toContain('Apartment hallway');
    expect(text).not.toContain('morning');
  });
});

describe('buildPreviewPrompt', () => {
  it('asks for a greyscale animatic frame and forbids text', () => {
    const prompt = buildPreviewPrompt(previewTextForShot(scene(), 1), []);
    expect(prompt.startsWith('Storyboard animatic frame.')).toBe(true);
    expect(prompt).toContain('greyscale only');
    expect(prompt.toLowerCase()).toContain('no text');
    expect(prompt).not.toContain('Art style');
    expect(prompt).not.toContain('Characters:');
  });

  it('describes only the characters the shot names, never a voice', () => {
    const prompt = buildPreviewPrompt('Mina waits by the door as Radio hums.', [
      character(),
      character({ name: 'Otto', physicalDescription: 'Stocky, bearded.' }),
      character({ name: 'Radio', voiceOnly: true }),
    ]);
    expect(prompt).toContain(
      'Characters: Mina: Female, 30s, Tall, cropped silver hair, wearing a long grey coat.'
    );
    expect(prompt).not.toContain('Otto');
    expect(prompt).not.toContain('Radio:');
  });

  it('drops the reference-image instruction a cast talent carries', () => {
    const prompt = buildPreviewPrompt('Mina waits.', [
      character({ physicalDescription: REFERENCE_LIKENESS_INSTRUCTION }),
    ]);
    expect(prompt).not.toContain('reference image');
    expect(prompt).toContain('Mina: Female, 30s, wearing a long grey coat.');
  });
});
