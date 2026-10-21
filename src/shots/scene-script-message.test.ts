import { describe, expect, it } from 'vitest';
import { dbSceneId } from '@/shots/scene-id';
import { cachedSceneHasNoScript } from './scene-script-message';

describe('cachedSceneHasNoScript', () => {
  it('is true only for a cached scene with no script', () => {
    const scenes = [
      { id: dbSceneId('missing'), script: null },
      { id: dbSceneId('empty'), script: { extract: '', dialogue: [] } },
    ];

    expect(cachedSceneHasNoScript(scenes, 'missing')).toBe(true);
    expect(cachedSceneHasNoScript(scenes, 'empty')).toBe(false);
    expect(cachedSceneHasNoScript(scenes, 'unknown')).toBe(false);
    expect(cachedSceneHasNoScript(undefined, 'missing')).toBe(false);
  });
});
