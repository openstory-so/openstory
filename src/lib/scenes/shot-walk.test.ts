import { describe, expect, it } from 'vitest';
import { adjacentShotId } from './shot-walk';

const shots = [
  { id: 'a', sceneId: 's1' },
  { id: 'b', sceneId: 's1' },
  { id: 'c', sceneId: 's2' },
];

describe('adjacentShotId', () => {
  it('returns null when there are no shots', () => {
    expect(adjacentShotId([], { sceneIds: [] }, 1)).toBeNull();
  });

  it('enters the first shot from sequence scope', () => {
    expect(adjacentShotId(shots, { sceneIds: [] }, 1)).toEqual({
      type: 'shot',
      id: 'a',
    });
  });

  it('does not walk back from sequence scope', () => {
    expect(adjacentShotId(shots, { sceneIds: [] }, -1)).toBeNull();
  });

  it('returns to sequence from the first shot', () => {
    expect(adjacentShotId(shots, { sceneIds: [], shotId: 'a' }, -1)).toEqual({
      type: 'sequence',
    });
  });

  it('walks forward through shots', () => {
    expect(adjacentShotId(shots, { sceneIds: [], shotId: 'a' }, 1)).toEqual({
      type: 'shot',
      id: 'b',
    });
    expect(adjacentShotId(shots, { sceneIds: [], shotId: 'b' }, 1)).toEqual({
      type: 'shot',
      id: 'c',
    });
  });

  it('stops at the last shot', () => {
    expect(adjacentShotId(shots, { sceneIds: [], shotId: 'c' }, 1)).toBeNull();
  });

  it('enters a selected scene at its first shot', () => {
    expect(adjacentShotId(shots, { sceneIds: ['s1'] }, 1)).toEqual({
      type: 'shot',
      id: 'a',
    });
    expect(adjacentShotId(shots, { sceneIds: ['s2'] }, 1)).toEqual({
      type: 'shot',
      id: 'c',
    });
  });

  it('walks back from a scene to the previous shot or sequence', () => {
    expect(adjacentShotId(shots, { sceneIds: ['s1'] }, -1)).toEqual({
      type: 'sequence',
    });
    expect(adjacentShotId(shots, { sceneIds: ['s2'] }, -1)).toEqual({
      type: 'shot',
      id: 'b',
    });
  });
});
