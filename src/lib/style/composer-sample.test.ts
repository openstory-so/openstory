import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { styleSlug } from '@/lib/style/style-slug';
import {
  pickShuffleStyle,
  sampleScriptForStyle,
  sampleScriptsForStyle,
} from './composer-sample';

// 'product-ad' has a hand-written override; 'award-season' a generated brief.
const productAd = { id: 'a', name: 'Product Ad', category: 'ecommerce' };
const awardSeason = { id: 'b', name: 'Award Season', category: 'film' };
// No override, no generated brief, unmapped category → no sample.
const unmapped = { id: 'c', name: 'Brand New Style', category: 'unmapped' };

describe('sampleScriptForStyle', () => {
  it('resolves a brief for known styles', () => {
    expect(sampleScriptForStyle(productAd)).toBeTruthy();
    expect(sampleScriptForStyle(awardSeason)).toBeTruthy();
  });

  it('offers the canonical brief plus its variants, canonical first', () => {
    const samples = sampleScriptsForStyle(productAd);
    expect(samples.length).toBeGreaterThan(1);
    expect(new Set(samples).size).toBe(samples.length);
    // The deterministic seed paths (?style=, sample renders) get this one.
    expect(sampleScriptForStyle(productAd, () => 0)).toBe(samples[0]);
    expect(sampleScriptForStyle(productAd, () => 0.99)).toBe(
      samples[samples.length - 1]
    );
  });

  // A style shipped without its variants silently loses the Shuffle variety
  // this is for — regenerate with `--variants 5` rather than deleting this.
  it('has variants for every shipped style', () => {
    const thin = DEFAULT_STYLE_TEMPLATES.filter(
      (style) => sampleScriptsForStyle(style).length < 6
    ).map((style) => styleSlug(style.name));
    expect(thin).toEqual([]);
  });

  it('returns null instead of throwing for an unmapped style', () => {
    expect(sampleScriptForStyle(unmapped)).toBeNull();
    expect(
      sampleScriptForStyle({ name: 'No Category', category: null })
    ).toBeNull();
  });
});

describe('pickShuffleStyle', () => {
  const styles = [productAd, awardSeason, unmapped];

  it('never picks the current style or one without a sample', () => {
    expect(pickShuffleStyle(styles, 'a', () => 0)).toBe(awardSeason);
    expect(pickShuffleStyle(styles, 'a', () => 0.99)).toBe(awardSeason);
  });

  it('picks by the injected random across eligible candidates', () => {
    expect(pickShuffleStyle(styles, null, () => 0)).toBe(productAd);
    expect(pickShuffleStyle(styles, null, () => 0.99)).toBe(awardSeason);
  });

  it('returns null when no other style has a sample', () => {
    expect(pickShuffleStyle([productAd, unmapped], 'a', () => 0)).toBeNull();
    expect(pickShuffleStyle([], null, () => 0)).toBeNull();
  });
});
