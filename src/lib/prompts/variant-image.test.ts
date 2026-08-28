import { describe, expect, it } from 'vitest';
import { getVariantImagePrompt } from './variant-image';

describe('getVariantImagePrompt', () => {
  it('requires a rigid equal-cell 3×3 with gutters and no bleed', () => {
    const prompt = getVariantImagePrompt('landscape_16_9');
    expect(prompt).toMatch(/3x3/);
    expect(prompt).toMatch(/equal/i);
    expect(prompt).toMatch(/gutter/i);
    expect(prompt).toMatch(/must not (cross|bleed|overlap)/i);
    expect(prompt).not.toMatch(/No borders between panels/i);
  });

  it('requires equal side-by-side panels for a 3×1 sheet', () => {
    const prompt = getVariantImagePrompt('landscape_16_9', undefined, {
      cols: 3,
      rows: 1,
    });
    expect(prompt).toMatch(/side-by-side/i);
    expect(prompt).toMatch(/gutter/i);
    expect(prompt).toMatch(/must not (cross|bleed|overlap)/i);
  });
});
