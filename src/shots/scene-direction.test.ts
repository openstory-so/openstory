import { describe, expect, it } from 'vitest';
import { sceneDirection, scenePromptContext } from './scene-direction';
import type { StyleConfig } from '@/look/style-config';
const style: StyleConfig = {
  version: 2,
  look: {
    mood: 'quiet',
    artStyle: 'watercolour',
    lighting: 'warm studio',
    colorPalette: ['blue', 'silver'],
    colorGrading: 'cool shadows',
  },
  motion: { camera: 'locked' },
  references: [],
};
describe('scene direction ownership', () => {
  it('removes obsolete style tags from LLM context and resolves the same editable direction', () => {
    const scene = {
      sceneId: 'scene',
      sceneNumber: 1,
      originalScript: { extract: 'The door opens.', dialogue: [] },
      metadata: {
        title: 'Kitchen',
        location: 'Kitchen',
        timeOfDay: 'night',
        storyBeat: '',
        durationSeconds: 3,
      },
      continuity: {
        characterTags: [],
        environmentTag: '',
        lightingSetup: '',
        colorPalette: 'sepia',
        styleTag: 'obsolete neon comic',
      },
    };
    const context = scenePromptContext(scene, style);
    expect(context.continuity?.styleTag).toBeUndefined();
    expect(context.direction.colorPalette).toBe('sepia');
    expect(context.continuity?.lightingSetup).toBe(
      context.direction.lightingSetup
    );
    expect(JSON.stringify(context)).not.toContain('obsolete neon comic');
    expect(scene.continuity.styleTag).toBe('obsolete neon comic');
  });

  it('takes the moment from the scene and the look from the style', () => {
    expect(
      sceneDirection(
        {
          metadata: { location: 'Kitchen', timeOfDay: 'night' },
          continuity: { lightingSetup: 'moonlight' },
        },
        style
      )
    ).toEqual({
      location: 'Kitchen',
      timeOfDay: 'night',
      lightingSetup: 'moonlight',
      colorPalette: 'blue, silver',
      look: 'watercolour, cool shadows',
    });
  });
  it('allows an explicit palette override and clearing restores the style', () => {
    expect(
      sceneDirection({ continuity: { colorPalette: 'sepia' } }, style)
        .colorPalette
    ).toBe('sepia');
    expect(
      sceneDirection({ continuity: { colorPalette: '  ' } }, style).colorPalette
    ).toBe('blue, silver');
  });
  it('defaults lighting from time of day, independently of style lighting', () => {
    expect(
      sceneDirection({ metadata: { timeOfDay: 'dawn' } }, style).lightingSetup
    ).toBe('Natural lighting appropriate to dawn');
  });
});
