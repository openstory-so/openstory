import { expect, it } from 'vitest';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/platform/server/db/schema';
import { buildCharacterReferenceImages } from './character-prompt';
import { buildLocationReferenceImages } from './location-prompt';
import { buildElementReferenceImages } from './element-prompt';
import { buildReferenceImagePrompt } from '@/stills/reference-image-prompt';

it('binds shuffled bible references by logical identity without mutating inputs', () => {
  // Database IDs and display names deliberately oppose logical bible order.
  const characters: CharacterMinimal[] = ['b', 'a'].map((characterId, i) => ({
    id: `character-${i}`,
    characterId,
    name: characterId === 'a' ? 'Zoe' : 'Ada',
    sheetImageUrl: `https://ref/character-${characterId}`,
    sheetStatus: 'completed',
    sheetInputHash: null,
    selectedSheetVersionId: null,
    physicalDescription: '',
    voiceOnly: false,
    isPerson: true,
    consistencyTag: characterId,
  }));
  const locations: SequenceLocationMinimal[] = ['set_b', 'set_a'].map(
    (locationId, i) => ({
      id: `location-${i}`,
      locationId,
      name: locationId,
      referenceImageUrl: `https://ref/${locationId}`,
      referenceStatus: 'completed',
      referenceInputHash: null,
      selectedReferenceVersionId: null,
      description: '',
      consistencyTag: locationId,
    })
  );
  const elements: SequenceElementMinimal[] = ['PROP_B', 'PROP_A'].map(
    (token, i) => ({
      id: `element-${i}`,
      token,
      imageUrl: `https://ref/${token}`,
      description: '',
      consistencyTag: token,
      kind: 'image',
      durationSeconds: null,
    })
  );
  const before = structuredClone({ characters, locations, elements });
  const refs = [
    ...buildCharacterReferenceImages(characters),
    ...buildLocationReferenceImages(locations),
    ...buildElementReferenceImages(elements),
  ];
  expect(refs).toEqual([
    ...buildCharacterReferenceImages([...characters].reverse()),
    ...buildLocationReferenceImages([...locations].reverse()),
    ...buildElementReferenceImages([...elements].reverse()),
  ]);
  expect({ characters, locations, elements }).toEqual(before);
  const result = buildReferenceImagePrompt(
    'Zoe Ada set_a set_b PROP_A PROP_B',
    [
      ...refs,
      {
        referenceImageUrl: 'https://ref/primary',
        description: 'Starting frame',
        role: 'primary',
      },
    ]
  );
  expect(result.referenceUrls).toEqual([
    'https://ref/primary',
    'https://ref/character-a',
    'https://ref/character-b',
    'https://ref/set_a',
    'https://ref/set_b',
    'https://ref/PROP_A',
    'https://ref/PROP_B',
  ]);
  expect(result.prompt).toContain(
    'Zoe (Image 2) Ada (Image 3) set_a (Image 4) set_b (Image 5) PROP_A (Image 6) PROP_B (Image 7)'
  );
});
