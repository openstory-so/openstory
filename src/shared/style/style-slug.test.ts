import { describe, expect, it } from 'vitest';
import { styleSlug } from './style-slug';

describe('styleSlug', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(styleSlug('Product Ad')).toBe('product-ad');
    expect(styleSlug('White Background Studio')).toBe(
      'white-background-studio'
    );
  });

  it('strips punctuation while keeping word boundaries', () => {
    expect(styleSlug('Neo-Noir Thriller')).toBe('neo-noir-thriller');
    expect(styleSlug('Food & Beverage Hero')).toBe('food-beverage-hero');
    expect(styleSlug('Sci-Fi Futuristic')).toBe('sci-fi-futuristic');
    expect(styleSlug('360 Turntable')).toBe('360-turntable');
  });

  it('collapses repeated and trailing separators', () => {
    expect(styleSlug('  Lo-Fi   Retro  ')).toBe('lo-fi-retro');
    expect(styleSlug('A & B')).toBe('a-b');
  });

  it('matches the legacy preview-url sanitizer for known templates', () => {
    // These mirror the exact strings previously inlined in getStylePreviewUrl /
    // sanitizeFolderName, guarding against accidental rule changes.
    expect(styleSlug('Award Season')).toBe('award-season');
    expect(styleSlug('UGC Unboxing')).toBe('ugc-unboxing');
    expect(styleSlug('As Seen On Phone')).toBe('as-seen-on-phone');
  });
});
