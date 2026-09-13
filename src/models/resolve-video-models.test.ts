import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_MODEL, type ImageToVideoModel } from './models';
import { resolveVideoModels } from './resolve-video-models';

describe('resolveVideoModels', () => {
  it('returns the videoModels array when non-empty', () => {
    const models: ImageToVideoModel[] = ['kling_v3_pro', 'seedance_v2'];
    expect(resolveVideoModels(models, undefined)).toEqual(models);
  });

  it('falls back to the legacy singular videoModel when array is empty/undefined', () => {
    expect(resolveVideoModels(undefined, 'seedance_v2')).toEqual([
      'seedance_v2',
    ]);
    expect(resolveVideoModels([], 'seedance_v2')).toEqual(['seedance_v2']);
  });

  it('falls back to the default model when neither is provided', () => {
    expect(resolveVideoModels(undefined, undefined)).toEqual([
      DEFAULT_VIDEO_MODEL,
    ]);
    expect(resolveVideoModels([], undefined)).toEqual([DEFAULT_VIDEO_MODEL]);
  });

  it('dedupes repeated models while preserving first-seen order (primary stays first)', () => {
    expect(
      resolveVideoModels(
        ['seedance_v2', 'kling_v3_pro', 'seedance_v2'],
        undefined
      )
    ).toEqual(['seedance_v2', 'kling_v3_pro']);
  });

  it('prefers the array over the legacy singular when both are present', () => {
    expect(resolveVideoModels(['kling_v3_pro'], 'seedance_v2')).toEqual([
      'kling_v3_pro',
    ]);
  });
});
