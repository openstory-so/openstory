import { describe, expect, it } from 'vitest';
import { buildMatchingPromptVariables } from './talent-matching-prompt';
import type { CharacterBibleEntry } from './scene-analysis.schema';

const character: CharacterBibleEntry = {
  characterId: 'jack',
  name: 'Jack',
  age: '30s',
  gender: 'male',
  ethnicity: '',
  physicalDescription: 'Wiry, sunburnt',
  standardClothing: 'dusty leather duster and a cowboy hat',
  distinguishingFeatures: 'scar on left cheek',
  consistencyTag: 'jack',
};

const talent = {
  id: 'tal-1',
  name: 'Sam',
  description: 'A ranch hand in a grey shirt',
  defaultSheet: {
    metadata: {
      characterId: 'sam',
      name: 'Sam',
      age: '30s',
      gender: 'male',
      ethnicity: '',
      physicalDescription: 'Wiry',
      standardClothing: 'grey shirt',
      distinguishingFeatures: '',
      consistencyTag: 'sam',
    },
  },
};

describe('buildMatchingPromptVariables', () => {
  it('includes costume on both characters and talent', () => {
    const vars = buildMatchingPromptVariables([character], [talent]);
    expect(vars.charactersDescription).toContain(
      'dusty leather duster and a cowboy hat'
    );
    expect(vars.talentDescription).toContain('grey shirt');
  });
});
