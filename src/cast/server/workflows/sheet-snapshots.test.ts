/**
 * Determinism tests for sheet-snapshot hash helpers.
 *
 * Hash determinism is the load-bearing contract for divergence detection.
 * A bug here makes the system either fire on every run (silent
 * over-regeneration, billing amplification) or never fire (silent stale
 * writes). The cases below pin the highest-risk invariants:
 *
 *   - Style-config null/undefined collapse
 *   - imageModel default-substitution agreement
 */

import { describe, expect, it } from 'vitest';
import type {
  CharacterSheetWorkflowInput,
  LibraryLocationSheetWorkflowInput,
  LibraryTalentSheetWorkflowInput,
  LocationSheetWorkflowInput,
} from '@/platform/server/workflow/types';
import type { SheetPayload } from './sheet-snapshots';
import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import {
  computeCharacterSheetHashFromDto,
  computeLibraryLocationSheetHashFromDto,
  computeLibraryTalentSheetHashFromDto,
  computeLocationSheetHashFromDto,
  computeStyleConfigHash,
} from './sheet-snapshots';

describe('computeStyleConfigHash', () => {
  it('collapses null and undefined to the same sentinel', async () => {
    const a = await computeStyleConfigHash(null);
    const b = await computeStyleConfigHash(undefined);
    expect(a).toBe('no-style');
    expect(b).toBe('no-style');
  });
});

describe('character-sheet hash', () => {
  const baseInput: SheetPayload<CharacterSheetWorkflowInput> = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 's1',
    characterDbId: 'c1',
    bibleVersionId: null,
    characterName: 'Jack',
    characterMetadata: {
      characterId: 'jack',
      name: 'Jack',
      age: '30s',
      gender: '',
      ethnicity: '',
      physicalDescription: '',
      standardClothing: '',
      distinguishingFeatures: '',
      personality: '',
      movement: '',
      voiceDescription: '',
      voiceOnly: false,
      isPerson: true,
      consistencyTag: 'jack',
    },
    imageModel: 'nano_banana_2',
    talentSheetInputHash: 'talent-v1',
    castTalentDescription: null,
  };

  it('treats missing imageModel as DEFAULT_IMAGE_MODEL on both paths', async () => {
    const omittedInput: SheetPayload<CharacterSheetWorkflowInput> = {
      ...baseInput,
      imageModel: undefined,
    };
    const explicitInput: SheetPayload<CharacterSheetWorkflowInput> = {
      ...baseInput,
      imageModel: DEFAULT_IMAGE_MODEL,
    };
    const omitted = await computeCharacterSheetHashFromDto(omittedInput);
    const explicit = await computeCharacterSheetHashFromDto(explicitInput);
    expect(omitted).toBe(explicit);
  });
});

describe('location-sheet hash', () => {
  const baseInput: SheetPayload<LocationSheetWorkflowInput> = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 's1',
    locationDbId: 'loc1',
    bibleVersionId: null,
    locationName: 'Docks',
    locationMetadata: {
      locationId: 'docks',
      name: 'Docks',
      type: 'exterior',
      timeOfDay: '',
      description: 'Foggy waterfront',
      architecturalStyle: '',
      keyFeatures: '',
      colorPalette: '',
      lightingSetup: '',
      ambiance: '',
      consistencyTag: 'docks',
      firstMention: { sceneId: '', text: '', lineNumber: 0 },
    },
    imageModel: 'nano_banana_2',
    libraryLocationReferenceHash: 'lib-v1',
  };

  it('moves with every bible field the prompt reads and the library link (#1785)', async () => {
    const base = await computeLocationSheetHashFromDto(baseInput);
    const relit = await computeLocationSheetHashFromDto({
      ...baseInput,
      locationMetadata: {
        ...baseInput.locationMetadata,
        lightingSetup: 'neon',
      },
    });
    const relinked = await computeLocationSheetHashFromDto({
      ...baseInput,
      libraryLocationReferenceHash: 'lib-v2',
    });
    expect(relit).not.toBe(base);
    expect(relinked).not.toBe(base);
  });
});

describe('library-talent-sheet hash', () => {
  const baseInput: SheetPayload<LibraryTalentSheetWorkflowInput> = {
    userId: 'u1',
    teamId: 't1',
    talentId: 'tal1',
    talentName: 'Alice',
    talentDescription: 'Lead actress',
    referenceImageUrls: ['https://r2/a.png', 'https://r2/b.png'],
    imageModel: 'nano_banana_2',
  };

  it('hashes are insensitive to inlined URL order (FromDto sorts)', async () => {
    const inputA = { ...baseInput, referenceImageUrls: ['x', 'y', 'z'] };
    const inputB = { ...baseInput, referenceImageUrls: ['z', 'x', 'y'] };
    const a = await computeLibraryTalentSheetHashFromDto(inputA);
    const b = await computeLibraryTalentSheetHashFromDto(inputB);
    expect(a).toBe(b);
  });
});

describe('library-location-sheet hash', () => {
  const baseInput: SheetPayload<LibraryLocationSheetWorkflowInput> = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'library',
    locationDbId: 'loc1',
    locationName: 'Rooftop Bar',
    locationDescription: 'Neon-lit, overlooking the harbour',
    referenceImageUrls: ['https://r2/a.png', 'https://r2/b.png'],
    imageModel: 'nano_banana_2',
  };

  it('is insensitive to inlined URL order', async () => {
    const a = await computeLibraryLocationSheetHashFromDto({
      ...baseInput,
      referenceImageUrls: ['x', 'y', 'z'],
    });
    const b = await computeLibraryLocationSheetHashFromDto({
      ...baseInput,
      referenceImageUrls: ['z', 'y', 'x'],
    });
    expect(a).toBe(b);
  });

  it('treats a missing imageModel as DEFAULT_IMAGE_MODEL', async () => {
    const omitted = await computeLibraryLocationSheetHashFromDto({
      ...baseInput,
      imageModel: undefined,
    });
    const explicit = await computeLibraryLocationSheetHashFromDto({
      ...baseInput,
      imageModel: DEFAULT_IMAGE_MODEL,
    });
    expect(omitted).toBe(explicit);
  });
});
