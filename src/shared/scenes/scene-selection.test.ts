import { describe, expect, it } from 'vitest';
import {
  ascendSelection,
  parseSelectionFromSearch,
  selectionScope,
  selectionToSearchParams,
  toggleSceneInSelection,
} from './scene-selection';

const shot = (
  id: string,
  sceneId: string
): { id: string; sceneId: string | null } => ({ id, sceneId });

describe('scene-selection', () => {
  it('parses URL search params', () => {
    expect(
      parseSelectionFromSearch({ scenes: 'a,b', shot: undefined })
    ).toEqual({ sceneIds: ['a', 'b'] });
    expect(parseSelectionFromSearch({ shot: 'shot-1' })).toEqual({
      sceneIds: [],
      shotId: 'shot-1',
    });
  });

  it('normalizes a URL carrying both scenes and shot to the shot', () => {
    expect(parseSelectionFromSearch({ scenes: 'a,b', shot: 'shot-1' })).toEqual(
      { sceneIds: [], shotId: 'shot-1' }
    );
  });

  it('serializes selection to search params', () => {
    expect(selectionToSearchParams({ sceneIds: ['a', 'b'] })).toEqual({
      scenes: 'a,b',
    });
    expect(selectionToSearchParams({ sceneIds: [], shotId: 's1' })).toEqual({
      shot: 's1',
    });
    expect(selectionToSearchParams({ sceneIds: [] })).toEqual({});
  });

  it('derives scope', () => {
    expect(selectionScope({ sceneIds: [] })).toBe('sequence');
    expect(selectionScope({ sceneIds: ['a'] })).toBe('scenes');
    expect(selectionScope({ sceneIds: [], shotId: 's' })).toBe('shot');
  });

  it('toggles scenes with additive modifier', () => {
    expect(toggleSceneInSelection({ sceneIds: ['a'] }, 'b', true)).toEqual({
      sceneIds: ['a', 'b'],
    });
    expect(toggleSceneInSelection({ sceneIds: ['a', 'b'] }, 'a', true)).toEqual(
      {
        sceneIds: ['b'],
      }
    );
  });

  it('replaces a shot selection when a scene is clicked', () => {
    expect(
      toggleSceneInSelection({ sceneIds: [], shotId: 's1' }, 'a', false)
    ).toEqual({ sceneIds: ['a'] });
    expect(
      toggleSceneInSelection({ sceneIds: [], shotId: 's1' }, 'a', true)
    ).toEqual({ sceneIds: ['a'], shotId: undefined });
  });

  it('non-additive click clears the sole selected scene, replaces otherwise', () => {
    expect(toggleSceneInSelection({ sceneIds: ['a'] }, 'a', false)).toEqual({
      sceneIds: [],
    });
    expect(
      toggleSceneInSelection({ sceneIds: ['a', 'b'] }, 'a', false)
    ).toEqual({ sceneIds: ['a'] });
    expect(toggleSceneInSelection({ sceneIds: ['a'] }, 'b', false)).toEqual({
      sceneIds: ['b'],
    });
  });

  it('ascends shot → scene → sequence', () => {
    const shots = [shot('s1', 'sc1'), shot('s2', 'sc2')];
    expect(ascendSelection({ sceneIds: [], shotId: 's1' }, shots)).toEqual({
      sceneIds: ['sc1'],
    });
    expect(ascendSelection({ sceneIds: ['sc1'] }, shots)).toEqual({
      sceneIds: [],
    });
    expect(ascendSelection({ sceneIds: ['a', 'b'] }, shots)).toEqual({
      sceneIds: [],
    });
    expect(ascendSelection({ sceneIds: [] }, shots)).toBeNull();
  });

  it('ascends to sequence when shot has no parent scene', () => {
    expect(
      ascendSelection({ sceneIds: [], shotId: 'missing' }, [shot('s1', 'sc1')])
    ).toEqual({ sceneIds: [] });
  });
});
