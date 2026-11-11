import { describe, expect, it } from 'vitest';
import { isImageHistoryVersion } from './shot-image.fn';

describe('isImageHistoryVersion', () => {
  it('keeps model stills', () => {
    expect(
      isImageHistoryVersion({ kind: 'model', sourceVariantId: null })
    ).toBe(true);
  });

  it('keeps a picked/upscaled tile (framing with a source sheet)', () => {
    expect(
      isImageHistoryVersion({ kind: 'framing', sourceVariantId: 'sheet-1' })
    ).toBe(true);
  });

  it('drops the 3×3 grid sheet itself', () => {
    expect(
      isImageHistoryVersion({ kind: 'framing', sourceVariantId: null })
    ).toBe(false);
  });

  it('keeps storyboard sketches (#2350)', () => {
    expect(
      isImageHistoryVersion({ kind: 'preview', sourceVariantId: null })
    ).toBe(true);
  });

  it('keeps user-uploaded stills', () => {
    expect(
      isImageHistoryVersion({ kind: 'upload', sourceVariantId: null })
    ).toBe(true);
  });
});
