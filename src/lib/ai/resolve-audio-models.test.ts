import { describe, expect, it } from 'vitest';
import { DEFAULT_MUSIC_MODEL, type AudioModel } from './models';
import { resolveAudioModels } from './resolve-audio-models';

describe('resolveAudioModels', () => {
  it('returns the audioModels array when non-empty', () => {
    const models: AudioModel[] = [DEFAULT_MUSIC_MODEL];
    expect(resolveAudioModels(models, undefined)).toEqual(models);
  });

  it('falls back to the legacy singular musicModel when array is empty/undefined', () => {
    expect(resolveAudioModels(undefined, DEFAULT_MUSIC_MODEL)).toEqual([
      DEFAULT_MUSIC_MODEL,
    ]);
    expect(resolveAudioModels([], DEFAULT_MUSIC_MODEL)).toEqual([
      DEFAULT_MUSIC_MODEL,
    ]);
  });

  it('falls back to the default model when neither is provided', () => {
    expect(resolveAudioModels(undefined, undefined)).toEqual([
      DEFAULT_MUSIC_MODEL,
    ]);
  });

  it('dedupes repeated models, preserving first-seen order', () => {
    expect(
      resolveAudioModels([DEFAULT_MUSIC_MODEL, DEFAULT_MUSIC_MODEL], undefined)
    ).toEqual([DEFAULT_MUSIC_MODEL]);
  });
});
