import { describe, expect, it } from 'vitest';
import { describeManifestCauses } from './staleness-causes';

const names = {
  characters: new Map([['c1', 'Mia']]),
  locations: new Map([['l1', 'Diner']]),
};

describe('describeManifestCauses (#2344)', () => {
  it.each([
    [
      'visual-prompt',
      ['character:c1/standardClothing', 'character:c1/styling'],
      ['Character "Mia": clothing, styling'],
    ],
    ['visual-prompt', ['character:c1#2/name'], ['Character "Mia": name']],
    ['visual-prompt', ['character:c9/age'], ['Character c9: age']],
    ['visual-prompt', ['location:l1/ambiance'], ['Location "Diner": ambiance']],
    ['visual-prompt', ['element:BOTTLE/description'], ['Element BOTTLE']],
    ['motion-prompt', ['scene/originalScript/dialogue/0/line'], ['Dialogue']],
    ['visual-prompt', ['scene/originalScript/dialogue/0/line'], ['Script']],
    ['visual-prompt', ['scene/metadata/timeOfDay'], ['Scene: time of day']],
    ['visual-prompt', ['styleConfig/lighting'], ['Style: lighting']],
    [
      'character-sheet',
      ['characterBible/physicalDescription'],
      ['description'],
    ],
    ['location-sheet', ['locationBible/keyFeatures'], ['features']],
    ['music-prompt', ['sceneSummaries/1/storyBeat'], ['Scene 2: story beat']],
    [
      'still',
      ['imageModel', 'characterSheetHashes/0'],
      ['Image model', 'Character sheet'],
    ],
    ['still', ['artifact', 'hashVersion', 'version'], []],
    ['still', ['whatever/x'], ['whatever/x']],
  ] as const)('%s %j → %j', (artifact, keys, expected) => {
    expect(describeManifestCauses(artifact, keys, names)).toEqual(expected);
  });

  it('groups a mixed diff per entity in key order', () => {
    expect(
      describeManifestCauses(
        'visual-prompt',
        ['styleConfig/mood', 'character:c1/styling', 'styleConfig/lighting'],
        names
      )
    ).toEqual(['Style: mood, lighting', 'Character "Mia": styling']);
  });
});
