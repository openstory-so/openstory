import type { Scene } from './scene-analysis.schema';
import { nameHexColours } from '@/look/colour-name';
import type { StyleConfig } from '@/look/style-config';

/** The moment belongs to the scene; palette, grading and art style to the look. */
export function sceneDirection(
  scene: {
    metadata?: { location?: string | null; timeOfDay?: string | null } | null;
    continuity?: {
      lightingSetup?: string | null;
      colorPalette?: string | null;
    } | null;
  },
  style?: StyleConfig
) {
  const timeOfDay = scene.metadata?.timeOfDay?.trim() || '';
  return {
    location: scene.metadata?.location?.trim() || '',
    timeOfDay,
    // Unknown lighting is left unsaid: a stock line fights the style's grade.
    lightingSetup: scene.continuity?.lightingSetup?.trim() || '',
    colorPalette: nameHexColours(
      scene.continuity?.colorPalette?.trim() ||
        [...new Set(style?.look.colorPalette.map(nameHexColours))].join(', ') ||
        ''
    ),
    look: [style?.look.medium, style?.look.artStyle, style?.look.colorGrading]
      .filter(Boolean)
      .join(', '),
  };
}

/** Prompt authors receive only the editable direction; legacy styleTag never competes. */
export function scenePromptContext(scene: Scene, style: StyleConfig) {
  const direction = sceneDirection(scene, style);
  return {
    ...scene,
    continuity: scene.continuity && {
      ...scene.continuity,
      lightingSetup: direction.lightingSetup,
      colorPalette: direction.colorPalette,
      styleTag: undefined,
    },
    direction,
  };
}
