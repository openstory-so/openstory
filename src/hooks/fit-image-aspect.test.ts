import { describe, expect, it } from 'vitest';
import {
  aspectRatioNumber,
  coverCropRect,
  imageMatchesAspectRatio,
} from './fit-image-aspect';

describe('aspectRatioNumber', () => {
  it('maps sequence ratios', () => {
    expect(aspectRatioNumber('16:9')).toBeCloseTo(16 / 9);
    expect(aspectRatioNumber('9:16')).toBeCloseTo(9 / 16);
    expect(aspectRatioNumber('1:1')).toBe(1);
  });
});

describe('imageMatchesAspectRatio', () => {
  it('accepts exact 16:9 pixel sizes', () => {
    expect(imageMatchesAspectRatio(1920, 1080, '16:9')).toBe(true);
    expect(imageMatchesAspectRatio(1280, 720, '16:9')).toBe(true);
  });

  it('rejects a square still for a 16:9 sequence', () => {
    expect(imageMatchesAspectRatio(1000, 1000, '16:9')).toBe(false);
  });

  it('rejects a portrait still for a landscape sequence', () => {
    expect(imageMatchesAspectRatio(1080, 1920, '16:9')).toBe(false);
    expect(imageMatchesAspectRatio(1080, 1920, '9:16')).toBe(true);
  });

  it('rejects zero dimensions', () => {
    expect(imageMatchesAspectRatio(0, 1080, '16:9')).toBe(false);
  });
});

describe('coverCropRect', () => {
  it('crops the sides of a too-wide image', () => {
    // 2:1 into 16:9
    expect(coverCropRect(2000, 1000, 16 / 9)).toEqual({
      sx: 111,
      sy: 0,
      sw: 1778,
      sh: 1000,
    });
  });

  it('crops the top and bottom of a too-tall image', () => {
    // 1:1 into 16:9. 1000×9/16 = 562.5 → 563 (Math.round half-up).
    expect(coverCropRect(1000, 1000, 16 / 9)).toEqual({
      sx: 0,
      sy: 219,
      sw: 1000,
      sh: 563,
    });
  });

  it('keeps a matching frame uncropped', () => {
    expect(coverCropRect(1920, 1080, 16 / 9)).toEqual({
      sx: 0,
      sy: 0,
      sw: 1920,
      sh: 1080,
    });
  });
});
