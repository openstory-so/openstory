import { describe, expect, it } from 'vitest';
import { sheetMetadataFromAnalysis } from './analyze-talent-media';

describe('sheetMetadataFromAnalysis', () => {
  it('maps vision fields onto a character bible entry', () => {
    const metadata = sheetMetadataFromAnalysis('Mara Quinn', {
      isCharacterSheet: true,
      subjectKind: 'human',
      suggestedName: 'Mara',
      description: 'A woman in a leather jacket.',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'Sharp bob',
      standardClothing: 'Leather jacket',
      distinguishingFeatures: 'Hoop earring',
    });
    expect(metadata).toMatchObject({
      characterId: 'mara_quinn',
      name: 'Mara Quinn',
      age: '30s',
      physicalDescription: 'Sharp bob',
      standardClothing: 'Leather jacket',
      consistencyTag: 'mara_quinn',
    });
  });

  it('falls back to the long description when physicalDescription is blank', () => {
    const metadata = sheetMetadataFromAnalysis('Sam', {
      isCharacterSheet: false,
      subjectKind: 'human',
      suggestedName: '',
      description: 'A ranch hand with sunburnt skin.',
      age: '',
      gender: '',
      ethnicity: '',
      physicalDescription: '  ',
      standardClothing: '',
      distinguishingFeatures: '',
    });
    expect(metadata.physicalDescription).toBe(
      'A ranch hand with sunburnt skin.'
    );
  });
});
