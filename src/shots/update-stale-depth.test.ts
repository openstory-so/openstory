import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UPDATE_STALE_DEPTH,
  depthIncludes,
  UPDATE_STALE_DEPTHS,
} from './update-stale-depth';

describe('update-stale depth (#1703)', () => {
  it('places dialogue between images and video', () => {
    expect(UPDATE_STALE_DEPTHS).toEqual([
      'prompts',
      'images',
      'dialogue',
      'video',
      'music',
    ]);
  });

  it('is cumulative: video includes dialogue; dialogue does not include video', () => {
    expect(depthIncludes('video', 'dialogue')).toBe(true);
    expect(depthIncludes('dialogue', 'video')).toBe(false);
    expect(depthIncludes('dialogue', 'images')).toBe(true);
    expect(depthIncludes('images', 'dialogue')).toBe(false);
  });

  it('defaults to dialogue so video stays one click away', () => {
    expect(DEFAULT_UPDATE_STALE_DEPTH).toBe('dialogue');
  });
});
