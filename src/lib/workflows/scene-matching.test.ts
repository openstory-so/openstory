import { describe, expect, it } from 'vitest';
import type { CharacterMinimal, SequenceElementMinimal } from '@/lib/db/schema';
import {
  matchCharacterToShotTags,
  matchCharactersToScene,
  matchElementsToScene,
  matchElementsToShotImage,
} from './scene-matching';

const elements: SequenceElementMinimal[] = [
  {
    id: '1',
    token: 'LOGO',
    description: 'A red hex logo',
    imageUrl: 'https://example.com/logo.png',
    consistencyTag: 'red-hex-logo',
  },
  {
    id: '2',
    token: 'BOTTLE',
    description: 'Silver water bottle',
    imageUrl: 'https://example.com/bottle.png',
    consistencyTag: 'silver-bottle',
  },
];

// Helper: build a CharacterMinimal with sane defaults so tests can override
// just the fields they care about.
function makeCharacter(
  overrides: Partial<CharacterMinimal> & {
    name: string;
    characterId: string;
  }
): CharacterMinimal {
  return {
    id: 'id_' + overrides.characterId,
    sheetImageUrl: null,
    sheetStatus: 'completed',
    sheetInputHash: null,
    selectedSheetVersionId: null,
    physicalDescription: null,
    consistencyTag: null,
    ...overrides,
  };
}

describe('matchCharacterToShotTags', () => {
  // Regression for sequence 01KQE5DTXJ93PB463JNW85TJV5: name "GIRL ONE" must
  // match snake_case tag emitted by the LLM.
  it('matches a spaced uppercase name against a snake_case tag', () => {
    const girlOne = makeCharacter({
      name: 'GIRL ONE',
      characterId: 'char_girl_one',
      consistencyTag: 'char_girl_one_scarlett_johansson',
    });
    expect(
      matchCharacterToShotTags(girlOne, [
        'girl_one_late_teens_bathroom_morning',
      ])
    ).toBe(true);
  });

  it('matches when the tag is exactly the name slug', () => {
    const girlOne = makeCharacter({
      name: 'GIRL ONE',
      characterId: 'char_girl_one',
    });
    expect(matchCharacterToShotTags(girlOne, ['girl_one'])).toBe(true);
  });

  it('is invariant to hyphens and other punctuation in the name', () => {
    const girlOne = makeCharacter({
      name: 'GIRL-ONE',
      characterId: 'char_girl_one',
    });
    expect(matchCharacterToShotTags(girlOne, ['girl_one'])).toBe(true);
  });

  it('does not match unrelated sibling characters', () => {
    const girlOne = makeCharacter({
      name: 'GIRL ONE',
      characterId: 'char_girl_one',
    });
    expect(matchCharacterToShotTags(girlOne, ['boy_two_running'])).toBe(false);
  });

  it('returns false for an empty tags array', () => {
    const girlOne = makeCharacter({
      name: 'GIRL ONE',
      characterId: 'char_girl_one',
    });
    expect(matchCharacterToShotTags(girlOne, [])).toBe(false);
  });

  it('rejects very short tags on the reverse direction', () => {
    const girlOne = makeCharacter({
      name: 'GIRL ONE',
      characterId: 'char_girl_one',
    });
    // Slugifies to "a" — would match "girl_one" reverse-direction without the floor
    expect(matchCharacterToShotTags(girlOne, ['a'])).toBe(false);
  });

  it('matches via characterId fallback when name slug differs', () => {
    const c = makeCharacter({
      name: 'Unnamed Stranger',
      characterId: 'char_001',
    });
    expect(matchCharacterToShotTags(c, ['char_001_in_doorway'])).toBe(true);
  });

  // Regression for sequence 01KQDZ5AY370HAPX736RHRWN0E — the LLM emitted
  // tokens in reversed order from the character's `name`.
  it('matches when the LLM reorders the name tokens in the tag', () => {
    const subject = makeCharacter({
      name: 'Subject (Anonymous)',
      characterId: 'char_001',
      consistencyTag: 'char_001_ben_affleck',
    });
    expect(
      matchCharacterToShotTags(subject, [
        'anonymous_subject_tattooed_gold_nosering_vintage_tee',
      ])
    ).toBe(true);
  });

  it('does not false-match when the name is a substring of a different word', () => {
    const jack = makeCharacter({ name: 'JACK', characterId: 'char_jack' });
    // Substring matcher would match "jack" inside "jacket"; token matcher must not.
    expect(matchCharacterToShotTags(jack, ['jacket_of_doom'])).toBe(false);
  });
});

describe('matchCharactersToScene', () => {
  it('agrees with the singular matcher for the same input', () => {
    const cast = [
      makeCharacter({ name: 'GIRL ONE', characterId: 'char_girl_one' }),
      makeCharacter({ name: 'GIRL TWO', characterId: 'char_girl_two' }),
      makeCharacter({ name: 'BOY ONE', characterId: 'char_boy_one' }),
    ];
    const tags = ['girl_one_bathroom', 'girl_two_lip_gloss'];
    const matched = matchCharactersToScene(cast, tags);
    expect(matched.map((c) => c.name).sort()).toEqual(['GIRL ONE', 'GIRL TWO']);
    for (const c of cast) {
      expect(matched.includes(c)).toBe(matchCharacterToShotTags(c, tags));
    }
  });

  it('returns an empty array when there are no tags', () => {
    const cast = [
      makeCharacter({ name: 'GIRL ONE', characterId: 'char_girl_one' }),
    ];
    expect(matchCharactersToScene(cast, [])).toEqual([]);
  });
});

describe('matchElementsToScene', () => {
  it('matches by elementTags primary path', () => {
    const result = matchElementsToScene(elements, ['LOGO']);
    expect(result.map((e) => e.token)).toEqual(['LOGO']);
  });

  it('matches case-insensitively via elementTags', () => {
    const result = matchElementsToScene(elements, ['logo']);
    expect(result.map((e) => e.token)).toEqual(['LOGO']);
  });

  it('falls back to script text when elementTags is empty', () => {
    const result = matchElementsToScene(
      elements,
      [],
      'She picks up the BOTTLE from the counter.'
    );
    expect(result.map((e) => e.token)).toEqual(['BOTTLE']);
  });

  it('returns empty list when elements list is empty', () => {
    const result = matchElementsToScene([], ['LOGO']);
    expect(result).toEqual([]);
  });

  it('does not match a token that appears inside another word', () => {
    const result = matchElementsToScene(
      elements,
      [],
      'The LOGOISTICS truck arrives.'
    );
    expect(result).toEqual([]);
  });

  it('matches multiple tokens in a single scene', () => {
    const result = matchElementsToScene(elements, ['LOGO', 'BOTTLE']);
    expect(result.map((e) => e.token).sort()).toEqual(['BOTTLE', 'LOGO']);
  });

  it('matches the UPPERCASE token verbatim in prompt text', () => {
    const result = matchElementsToScene(
      [{ token: 'BIG_CORP' }],
      [],
      'displaying the BIG_CORP banner on the wall'
    );
    expect(result.map((e) => e.token)).toEqual(['BIG_CORP']);
  });
});

describe('matchElementsToShotImage', () => {
  it('matches the token in the visual prompt even when tags/extract do not', () => {
    const result = matchElementsToShotImage(elements, {
      visualPrompt: 'displaying the UI from (LOGO)',
      elementTags: [],
      sceneExtract: 'She talks about the product.',
    });
    expect(result.map((e) => e.token)).toEqual(['LOGO']);
  });

  it('ignores scene tags and extract when a visual prompt is present', () => {
    const result = matchElementsToShotImage(elements, {
      visualPrompt: 'Close-up of her face. No product in frame.',
      elementTags: ['LOGO', 'BOTTLE'],
      sceneExtract: 'She picks up the BOTTLE and the LOGO glows.',
    });
    expect(result).toEqual([]);
  });

  it('falls back to tags + extract when the visual prompt is empty', () => {
    const result = matchElementsToShotImage(elements, {
      visualPrompt: '   ',
      elementTags: ['LOGO'],
      sceneExtract: 'The BOTTLE sits on the counter.',
    });
    expect(result.map((e) => e.token).sort()).toEqual(['BOTTLE', 'LOGO']);
  });
});
