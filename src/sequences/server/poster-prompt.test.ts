import { describe, expect, it } from 'vitest';
import {
  buildPreviewPrompt,
  previewTextForShot,
  type PreviewShotScene,
} from './poster-prompt';

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
    expect(text).toContain('She opens the door');
    expect(text).toContain('Apartment hallway');
    expect(text).toContain('morning');
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

  it('drops ALL-CAPS sluglines so they are not drawn as signage', () => {
    const text = previewTextForShot(
      scene({
        metadata: {
          title: 'The hallway',
          location: 'DOWNTOWN CROSSWALK',
          timeOfDay: 'LATE MORNING',
        },
      }),
      1
    );
    expect(text).not.toContain('DOWNTOWN CROSSWALK');
    expect(text).not.toContain('LATE MORNING');
    expect(text).toContain('She fills the right third, doorway left');
  });
});

describe('buildPreviewPrompt', () => {
  it('asks for a line-art animatic and forbids text', () => {
    const prompt = buildPreviewPrompt(previewTextForShot(scene(), 1));
    expect(prompt.startsWith('Animatic frame.')).toBe(true);
    expect(prompt).toContain('Loose freehand black line drawing');
    expect(prompt.toLowerCase()).toContain('no text');
    expect(prompt).not.toContain('Art style');
  });
});
