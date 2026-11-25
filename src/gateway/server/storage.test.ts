import { describe, expect, it } from 'vitest';
import { outputExtension } from './storage';

describe('outputExtension', () => {
  it('prefers the URL extension when present', () => {
    expect(outputExtension('https://fal.media/a.PNG', 'video/mp4')).toBe('png');
  });

  it('derives from content type for extension-less URLs', () => {
    expect(outputExtension('https://fal.media/v3/files/abc', 'video/mp4')).toBe(
      'mp4'
    );
    expect(
      outputExtension('https://fal.media/x', 'audio/mpeg; charset=binary')
    ).toBe('mp3');
  });

  it('falls back to bin when neither source knows', () => {
    expect(outputExtension('https://fal.media/x', null)).toBe('bin');
    expect(outputExtension('https://fal.media/x', 'application/mystery')).toBe(
      'bin'
    );
  });
});
