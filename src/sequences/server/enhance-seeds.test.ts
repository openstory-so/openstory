import { describe, expect, it } from 'vitest';
import { createUserPrompt } from '@/sequences/script-enhancer';
import { ENHANCE_SEED_DATA } from './enhance-seeds.data';
import { drawEnhanceSeeds } from './enhance-seeds';

const first = () => 0;
const thin = { invent: false, hasStyle: true, country: 'AU' };

describe('drawEnhanceSeeds (#2076)', () => {
  it('draws name and town from the user country for a thin brief', () => {
    const seeds = drawEnhanceSeeds(
      { ...thin, script: 'a new makeup ad' },
      first
    );
    expect(seeds).toEqual({
      womenNames: ['Charlotte', 'Amelia'],
      menNames: ['Oliver', 'Noah'],
      town: `${ENHANCE_SEED_DATA.towns.AU.split('|')[0]}, Australia`,
      venue: ENHANCE_SEED_DATA.venues.split('|')[0],
      occupation: ENHANCE_SEED_DATA.jobs.split('|')[0],
      genre: null,
    });
  });

  it('leaves a specific brief alone', () => {
    const script =
      'Scarlett, 19, a Bondi Beach influencer, unboxes a new coral lipstick at her sunlit vanity and turns it slowly to camera.';
    expect(drawEnhanceSeeds({ ...thin, script })).toBeUndefined();
    expect(createUserPrompt(script)).not.toContain('Starting points');
  });

  it('draws a genre only for a blank page with no style', () => {
    const invent = { script: '', invent: true, country: 'AU' };
    expect(
      drawEnhanceSeeds({ ...invent, hasStyle: false })?.genre
    ).toBeTruthy();
    expect(drawEnhanceSeeds({ ...invent, hasStyle: true })?.genre).toBeNull();
  });

  it('gives no name where the country has no name list, never another country', () => {
    // Fiji: towns, no names.
    const seeds = drawEnhanceSeeds({
      ...thin,
      script: 'a brand film',
      country: 'FJ',
    });
    expect(seeds?.womenNames).toEqual([]);
    expect(seeds?.menNames).toEqual([]);
    expect(seeds?.town).toMatch(/, Fiji$/);
  });

  it('draws a country when the user has none, so name and town match', () => {
    const seeds = drawEnhanceSeeds(
      { ...thin, script: 'a brand film', country: undefined },
      first
    );
    expect(seeds?.womenNames).toHaveLength(2);
    expect(seeds?.menNames).toHaveLength(2);
    expect(seeds?.town).toBeTruthy();
  });

  it('reaches the user prompt', () => {
    const prompt = createUserPrompt('a brand film', {
      seeds: {
        womenNames: ['Matilda'],
        menNames: ['Hudson'],
        town: 'Ballarat, Australia',
        venue: 'ice rink',
        occupation: 'Crane Operator',
        genre: null,
      },
    });
    expect(prompt).toContain("- Women's first names: Matilda");
    expect(prompt).toContain("- Men's first names: Hudson");
    expect(prompt).toContain('- Town: Ballarat, Australia');
    expect(prompt).toContain('- Kind of place: ice rink');
    expect(prompt).toContain("- A character's job: Crane Operator");
    expect(prompt).not.toContain('- Genre');
  });
});
