import { describe, expect, it } from 'vitest';
import { sceneDirection } from './scene-direction';
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
