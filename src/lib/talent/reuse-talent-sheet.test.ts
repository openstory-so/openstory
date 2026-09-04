import { describe, expect, it } from 'vitest';
import {
  reusesTalentSheet,
  jaccard,
  shouldReuseTalentSheet,
  tokenizeAppearance,
} from './reuse-talent-sheet';

describe('tokenizeAppearance', () => {
  it('drops stopwords and generic clothing words', () => {
    expect(tokenizeAppearance('wearing casual clothes and a red hat')).toEqual(
      new Set(['red', 'hat'])
    );
  });

  it('returns empty for blank or generic-only strings', () => {
    expect(tokenizeAppearance('')).toEqual(new Set());
    expect(tokenizeAppearance('casual streetwear')).toEqual(new Set());
    expect(tokenizeAppearance(null)).toEqual(new Set());
  });
});

describe('jaccard', () => {
  it('is 1 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('is 0 for disjoint sets', () => {
    expect(jaccard(new Set(['cowboy', 'hat']), new Set(['spacesuit']))).toBe(0);
  });
});

describe('shouldReuseTalentSheet', () => {
  it('reuses when the character has no distinctive costume', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: '',
        talentDescription: 'A man in a grey t-shirt',
      })
    ).toBe(true);
  });

  it('reuses when character clothing is generic', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: 'casual streetwear',
        talentClothing: 'grey t-shirt',
      })
    ).toBe(true);
  });

  it('reuses when the talent sheet already shows the same costume', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: 'dusty leather duster and a cowboy hat',
        talentClothing: 'leather duster, cowboy hat, boots',
      })
    ).toBe(true);
  });

  it('reuses a matching costume even when the talent bio is long', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: 'dusty leather duster and a cowboy hat',
        talentClothing: 'leather duster, cowboy hat, boots',
        talentDescription:
          'A weathered ranch hand with sunburnt skin, a slow drawl, and a habit of rolling his sleeves. Forty-word vision dump about lighting, mood, and studio backdrop that must not dilute costume overlap.',
      })
    ).toBe(true);
  });

  it('regenerates when clothes match but distinctive features are missing', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: 'leather duster and a cowboy hat',
        talentClothing: 'leather duster, cowboy hat',
        characterFeatures: 'deep scar across the left cheek',
        talentFeatures: '',
        talentDescription: 'A ranch hand in a duster',
      })
    ).toBe(false);
  });

  it('regenerates when the role costume is specific and the talent sheet is not', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: 'dusty leather duster and a cowboy hat',
        talentClothing: '',
        talentDescription: 'Headshot of a man in a grey t-shirt',
      })
    ).toBe(false);
  });

  it('regenerates when costumes are disjoint', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: 'white spacesuit with gold visor',
        talentClothing: 'red evening gown',
      })
    ).toBe(false);
  });

  it('regenerates when the character has distinctive features missing from talent', () => {
    expect(
      shouldReuseTalentSheet({
        characterClothing: '',
        characterFeatures: 'deep scar across the left cheek',
        talentDescription: 'A woman with long dark hair',
      })
    ).toBe(false);
  });

  it('reuses when distinctive features already appear on the talent', () => {
    expect(
      shouldReuseTalentSheet({
        characterFeatures: 'deep scar across the left cheek',
        talentFeatures: 'scar on left cheek',
        talentDescription: 'Weathered face, left-cheek scar',
      })
    ).toBe(true);
  });
});

describe('reusesTalentSheet', () => {
  const CHARACTER = {
    standardClothing: 'yellow rain jacket',
    distinguishingFeatures: 'scar over left eyebrow',
  };

  it('is false with no match at all', () => {
    expect(reusesTalentSheet(CHARACTER, undefined)).toBe(false);
  });

  it('is false when the matched talent has no sheet image to copy', () => {
    // The reservation gate counts on this: no sheet URL means the character
    // sheet is generated, and generation is what gets billed.
    expect(
      reusesTalentSheet(CHARACTER, {
        sheetMetadata: {
          standardClothing: 'yellow rain jacket',
          distinguishingFeatures: 'scar over left eyebrow',
        },
      })
    ).toBe(false);
  });

  it('is true when the talent sheet already wears the role', () => {
    expect(
      reusesTalentSheet(CHARACTER, {
        sheetImageUrl: 'https://example.com/talent.png',
        sheetMetadata: {
          standardClothing: 'yellow rain jacket',
          distinguishingFeatures: 'scar over left eyebrow',
        },
      })
    ).toBe(true);
  });

  it('is false when the role wardrobe diverges from the talent sheet', () => {
    expect(
      reusesTalentSheet(CHARACTER, {
        sheetImageUrl: 'https://example.com/talent.png',
        sheetMetadata: {
          standardClothing: 'charcoal three-piece suit',
          distinguishingFeatures: 'clean shaven',
        },
      })
    ).toBe(false);
  });
});
