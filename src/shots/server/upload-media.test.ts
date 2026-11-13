import { describe, expect, it } from 'vitest';
import { requireMixedUploadExtension } from './upload-media';

describe('requireMixedUploadExtension', () => {
  it.each([
    ['a.PNG', 'png'],
    ['clip.mov', 'mov'],
    ['take.flac', 'flac'],
  ])('stores %s as %s', (name, ext) => {
    expect(requireMixedUploadExtension(name)).toBe(ext);
  });

  // `x.svg?` once read as no image here and as `svg` at the storage path.
  it.each([
    'x.svg',
    'x.svg?',
    'x.svg#a',
    'a.html',
    'a.avif',
    'a.heic',
    'noext',
  ])('refuses %s', (name) => {
    expect(() => requireMixedUploadExtension(name)).toThrow(
      'Unsupported file type'
    );
  });
});
