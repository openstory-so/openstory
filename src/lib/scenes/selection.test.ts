import { describe, expect, it } from 'vitest';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import {
  EMPTY_SELECTION,
  extendSceneRange,
  orderedSceneIds,
  rangeSelectScenes,
  scopeOf,
  selectScene,
  selectShot,
  selectionTags,
  shotsInSelection,
  stepScene,
  stepShot,
  toggleScene,
  zoomOut,
  type SelectableShot,
} from './selection';

function makeMetadata(overrides: {
  characterTags?: string[];
  environmentTag?: string;
  elementTags?: string[];
  location?: string;
  extract?: string;
}): Scene {
  return {
    sceneId: 'scene_x',
    sceneNumber: 1,
    originalScript: {
      extract: overrides.extract ?? 'INT. SOMEWHERE',
      dialogue: [],
    },
    metadata: {
      title: 'A scene',
      durationSeconds: 5,
      location: overrides.location ?? 'Somewhere',
      timeOfDay: 'day',
      storyBeat: 'setup',
    },
    continuity: {
      characterTags: overrides.characterTags ?? [],
      environmentTag: overrides.environmentTag ?? '',
      elementTags: overrides.elementTags ?? [],
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
}

// Two scenes: A (shots 1, 2) and B (shot 3). Order indexes are deliberately
// passed unsorted to the helpers to verify they sort.
const shot1: SelectableShot = {
  id: 'shot1',
  sceneId: 'sceneA',
  orderIndex: 0,
  metadata: makeMetadata({
    characterTags: ['HERO'],
    environmentTag: 'diner',
    elementTags: ['LOGO'],
    extract: 'Shot one extract',
  }),
};
const shot2: SelectableShot = {
  id: 'shot2',
  sceneId: 'sceneA',
  orderIndex: 1,
  metadata: makeMetadata({
    characterTags: ['HERO', 'VILLAIN'],
    environmentTag: 'diner',
    extract: 'Shot two extract',
  }),
};
const shot3: SelectableShot = {
  id: 'shot3',
  sceneId: 'sceneB',
  orderIndex: 2,
  metadata: makeMetadata({
    characterTags: ['SIDEKICK'],
    environmentTag: 'rooftop',
    elementTags: ['PRODUCT'],
    extract: 'Shot three extract',
  }),
};
const shots = [shot3, shot1, shot2];

describe('scopeOf', () => {
  it('derives the scope from the selection shape', () => {
    expect(scopeOf(EMPTY_SELECTION)).toBe('sequence');
    expect(scopeOf(selectScene('sceneA'))).toBe('scene');
    expect(scopeOf(selectShot('shot1'))).toBe('shot');
  });
});

describe('shotsInSelection', () => {
  it('returns all shots in order at sequence scope', () => {
    expect(shotsInSelection(EMPTY_SELECTION, shots).map((s) => s.id)).toEqual([
      'shot1',
      'shot2',
      'shot3',
    ]);
  });

  it('returns the selected scenes’ shots in order', () => {
    expect(
      shotsInSelection({ sceneIds: ['sceneB', 'sceneA'] }, shots).map(
        (s) => s.id
      )
    ).toEqual(['shot1', 'shot2', 'shot3']);
    expect(
      shotsInSelection({ sceneIds: ['sceneB'] }, shots).map((s) => s.id)
    ).toEqual(['shot3']);
  });

  it('returns just the selected shot at shot scope', () => {
    expect(
      shotsInSelection(selectShot('shot2'), shots).map((s) => s.id)
    ).toEqual(['shot2']);
  });
});

describe('selectionTags', () => {
  it('is null (no filter) at sequence scope', () => {
    expect(selectionTags(EMPTY_SELECTION, shots)).toBeNull();
  });

  it('unions tags across the selected scenes’ shots, deduped', () => {
    const tags = selectionTags({ sceneIds: ['sceneA'] }, shots);
    expect(tags?.characterTags).toEqual(['HERO', 'VILLAIN']);
    expect(tags?.environmentTags).toEqual(['diner', 'Somewhere']);
    expect(tags?.elementTags).toEqual(['LOGO']);
    expect(tags?.scriptExtracts).toEqual([
      'Shot one extract',
      'Shot two extract',
    ]);
  });

  it('unions across multiple scenes', () => {
    const tags = selectionTags({ sceneIds: ['sceneA', 'sceneB'] }, shots);
    expect(tags?.characterTags).toEqual(['HERO', 'VILLAIN', 'SIDEKICK']);
    expect(tags?.elementTags).toEqual(['LOGO', 'PRODUCT']);
  });

  it('returns only the shot’s own tags at shot scope', () => {
    const tags = selectionTags(selectShot('shot3'), shots);
    expect(tags?.characterTags).toEqual(['SIDEKICK']);
    expect(tags?.environmentTags).toEqual(['rooftop', 'Somewhere']);
  });
});

describe('selection transitions', () => {
  it('toggleScene adds and removes scenes from the multi-selection', () => {
    const one = toggleScene(EMPTY_SELECTION, 'sceneA');
    expect(one.sceneIds).toEqual(['sceneA']);
    const two = toggleScene(one, 'sceneB');
    expect(two.sceneIds).toEqual(['sceneA', 'sceneB']);
    expect(toggleScene(two, 'sceneA').sceneIds).toEqual(['sceneB']);
  });

  it('rangeSelectScenes selects the contiguous range from the anchor', () => {
    const fromA = rangeSelectScenes(selectScene('sceneA'), 'sceneB', shots);
    expect(fromA.sceneIds).toEqual(['sceneA', 'sceneB']);
    // Reversed anchor/target still yields spine order.
    const fromB = rangeSelectScenes(selectScene('sceneB'), 'sceneA', shots);
    expect(fromB.sceneIds).toEqual(['sceneA', 'sceneB']);
    // No anchor → plain select.
    expect(
      rangeSelectScenes(EMPTY_SELECTION, 'sceneB', shots).sceneIds
    ).toEqual(['sceneB']);
  });

  it('zoomOut steps shot → scene → sequence', () => {
    const sceneScope = zoomOut(selectShot('shot2'), shots);
    expect(sceneScope).toEqual({ sceneIds: ['sceneA'] });
    expect(zoomOut(sceneScope, shots)).toEqual(EMPTY_SELECTION);
    expect(zoomOut(EMPTY_SELECTION, shots)).toEqual(EMPTY_SELECTION);
  });

  it('stepShot walks the flat order and clamps at the ends', () => {
    expect(stepShot(selectShot('shot1'), shots, 1).shotId).toBe('shot2');
    expect(stepShot(selectShot('shot2'), shots, 1).shotId).toBe('shot3');
    expect(stepShot(selectShot('shot3'), shots, 1).shotId).toBe('shot3');
    expect(stepShot(selectShot('shot1'), shots, -1).shotId).toBe('shot1');
  });

  it('stepShot enters the covered shots from scene/sequence scope', () => {
    expect(stepShot(EMPTY_SELECTION, shots, 1).shotId).toBe('shot1');
    expect(stepShot(EMPTY_SELECTION, shots, -1).shotId).toBe('shot3');
    expect(stepShot({ sceneIds: ['sceneB'] }, shots, 1).shotId).toBe('shot3');
  });

  it('stepScene moves scene-wise from any scope', () => {
    expect(stepScene(selectScene('sceneA'), shots, 1).sceneIds).toEqual([
      'sceneB',
    ]);
    expect(stepScene(selectShot('shot1'), shots, 1).sceneIds).toEqual([
      'sceneB',
    ]);
    expect(stepScene(EMPTY_SELECTION, shots, 1).sceneIds).toEqual(['sceneA']);
    expect(stepScene(selectScene('sceneA'), shots, -1).sceneIds).toEqual([
      'sceneA',
    ]);
  });

  it('extendSceneRange grows and shrinks at the trailing edge', () => {
    const grown = extendSceneRange(selectScene('sceneA'), shots, 1);
    expect(grown.sceneIds).toEqual(['sceneA', 'sceneB']);
    const shrunk = extendSceneRange(grown, shots, -1);
    expect(shrunk.sceneIds).toEqual(['sceneA']);
    // Clamped at the end of the spine.
    expect(extendSceneRange(grown, shots, 1).sceneIds).toEqual([
      'sceneA',
      'sceneB',
    ]);
  });

  it('orderedSceneIds preserves spine order and dedupes', () => {
    expect(orderedSceneIds(shots)).toEqual(['sceneA', 'sceneB']);
  });
});
