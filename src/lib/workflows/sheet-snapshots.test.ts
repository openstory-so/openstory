/**
 * Determinism tests for sheet-snapshot hash helpers.
 *
 * Hash determinism is the load-bearing contract for divergence detection.
 * A bug here makes the system either fire on every run (silent
 * over-regeneration, billing amplification) or never fire (silent stale
 * writes). The cases below pin the highest-risk invariants:
 *
 *   - FromDto/Current parity for each helper pair
 *   - Sort-asymmetry between FromDto and Current paths
 *   - Style-config null/undefined collapse
 *   - imageModel default-substitution agreement
 */

import { describe, expect, it } from 'vitest';
import type {
  CharacterSheetWorkflowInput,
  LibraryLocationSheetWorkflowInput,
  LibraryTalentSheetWorkflowInput,
  LocationSheetWorkflowInput,
} from '@/lib/workflow/types';
import type { ScopedDb } from '@/lib/db/scoped';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  computeCharacterSheetHashCurrent,
  computeCharacterSheetHashFromDto,
  computeLibraryLocationSheetHashCurrent,
  computeLibraryLocationSheetHashFromDto,
  computeLibraryTalentSheetHashCurrent,
  computeLibraryTalentSheetHashFromDto,
  computeLocationSheetHashCurrent,
  computeLocationSheetHashFromDto,
  computeStyleConfigHash,
} from './sheet-snapshots';

// Shape-matching stubs: each helper only needs the methods it actually calls.
// We type as `unknown as ScopedDb` so a future helper that reaches deeper
// fails loudly rather than reading `undefined`.
type CharacterStub = {
  characters: { getById: (id: string) => Promise<unknown> };
  talent: { getWithRelations: (id: string) => Promise<unknown> };
};

type LocationStub = {
  sequenceLocations: { getById: (id: string) => Promise<unknown> };
  locations: { getById: (id: string) => Promise<unknown> };
};

type TalentStub = {
  talent: { getWithRelations: (id: string) => Promise<unknown> };
};

type LibraryLocationStub = {
  locations: { getById: (id: string) => Promise<unknown> };
};

function asScopedDb<T>(stub: T): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test stub
  return stub as unknown as ScopedDb;
}

describe('computeStyleConfigHash', () => {
  it('collapses null and undefined to the same sentinel', async () => {
    const a = await computeStyleConfigHash(null);
    const b = await computeStyleConfigHash(undefined);
    expect(a).toBe('no-style');
    expect(b).toBe('no-style');
  });
});

describe('character-sheet hash', () => {
  const baseInput: CharacterSheetWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 's1',
    characterDbId: 'c1',
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
      consistencyTag: 'jack',
    },
    imageModel: 'nano_banana_2',
    talentSheetInputHash: 'talent-v1',
  };

  it('FromDto and Current produce identical hashes when DB matches DTO', async () => {
    const dtoHash = await computeCharacterSheetHashFromDto(baseInput);

    const stub: CharacterStub = {
      characters: {
        getById: async () => ({ id: 'c1', talentId: 'tal1' }),
      },
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          sheets: [{ isDefault: true, inputHash: 'talent-v1' }],
        }),
      },
    };
    const currentHash = await computeCharacterSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });

  it('detects divergence when upstream talent-sheet hash changes', async () => {
    const dtoHash = await computeCharacterSheetHashFromDto(baseInput);
    const stub: CharacterStub = {
      characters: { getById: async () => ({ id: 'c1', talentId: 'tal1' }) },
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          sheets: [{ isDefault: true, inputHash: 'talent-v2' }],
        }),
      },
    };
    const currentHash = await computeCharacterSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).not.toBe(currentHash);
  });

  it('treats missing imageModel as DEFAULT_IMAGE_MODEL on both paths', async () => {
    const omittedInput: CharacterSheetWorkflowInput = {
      ...baseInput,
      imageModel: undefined,
    };
    const explicitInput: CharacterSheetWorkflowInput = {
      ...baseInput,
      imageModel: DEFAULT_IMAGE_MODEL,
    };
    const omitted = await computeCharacterSheetHashFromDto(omittedInput);
    const explicit = await computeCharacterSheetHashFromDto(explicitInput);
    expect(omitted).toBe(explicit);
  });
});

describe('location-sheet hash', () => {
  const baseInput: LocationSheetWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 's1',
    locationDbId: 'loc1',
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

  it('FromDto and Current match when DB matches DTO', async () => {
    const dtoHash = await computeLocationSheetHashFromDto(baseInput);
    const stub: LocationStub = {
      sequenceLocations: {
        getById: async () => ({ id: 'loc1', libraryLocationId: 'lib1' }),
      },
      locations: {
        getById: async () => ({ id: 'lib1', referenceInputHash: 'lib-v1' }),
      },
    };
    const currentHash = await computeLocationSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });

  it('diverges when library-location reference hash changes', async () => {
    const dtoHash = await computeLocationSheetHashFromDto(baseInput);
    const stub: LocationStub = {
      sequenceLocations: {
        getById: async () => ({ id: 'loc1', libraryLocationId: 'lib1' }),
      },
      locations: {
        getById: async () => ({ id: 'lib1', referenceInputHash: 'lib-v2' }),
      },
    };
    const currentHash = await computeLocationSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).not.toBe(currentHash);
  });
});

describe('library-talent-sheet hash', () => {
  const baseInput: LibraryTalentSheetWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    talentId: 'tal1',
    talentName: 'Alice',
    talentDescription: 'Lead actress',
    referenceImageUrls: ['https://r2/a.png', 'https://r2/b.png'],
    imageModel: 'nano_banana_2',
  };

  it('FromDto matches Current when DB media matches the inlined URL set', async () => {
    const dtoHash = await computeLibraryTalentSheetHashFromDto(baseInput);
    const stub: TalentStub = {
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          name: 'Alice',
          description: 'Lead actress',
          media: [
            { type: 'image', url: 'https://r2/b.png' },
            { type: 'image', url: 'https://r2/a.png' },
          ],
        }),
      },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });

  it('hashes are insensitive to inlined URL order (FromDto sorts)', async () => {
    const inputA = { ...baseInput, referenceImageUrls: ['x', 'y', 'z'] };
    const inputB = { ...baseInput, referenceImageUrls: ['z', 'x', 'y'] };
    const a = await computeLibraryTalentSheetHashFromDto(inputA);
    const b = await computeLibraryTalentSheetHashFromDto(inputB);
    expect(a).toBe(b);
  });

  it('stays convergent when live media is a superset of the snapshot URLs', async () => {
    const dtoHash = await computeLibraryTalentSheetHashFromDto(baseInput);
    const stub: TalentStub = {
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          name: 'Alice',
          description: 'Lead actress',
          media: [
            { type: 'image', url: 'https://r2/a.png' },
            { type: 'image', url: 'https://r2/b.png' },
            { type: 'image', url: 'https://r2/c.png' },
          ],
        }),
      },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });

  it('stays convergent when a name-only snapshot gains photos mid-run', async () => {
    const nameOnly = { ...baseInput, referenceImageUrls: [] };
    const dtoHash = await computeLibraryTalentSheetHashFromDto(nameOnly);
    const stub: TalentStub = {
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          name: 'Alice',
          description: 'Lead actress',
          media: [{ type: 'image', url: 'https://r2/a.png' }],
        }),
      },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      nameOnly,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });

  it('diverges when a snapshot reference URL is missing from live media', async () => {
    const dtoHash = await computeLibraryTalentSheetHashFromDto(baseInput);
    const stub: TalentStub = {
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          name: 'Alice',
          description: 'Lead actress',
          media: [{ type: 'image', url: 'https://r2/a.png' }],
        }),
      },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).not.toBe(currentHash);
  });

  it('non-image media is excluded from the live hash', async () => {
    const dtoHash = await computeLibraryTalentSheetHashFromDto(baseInput);
    const stub: TalentStub = {
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          name: 'Alice',
          description: 'Lead actress',
          media: [
            { type: 'image', url: 'https://r2/a.png' },
            { type: 'image', url: 'https://r2/b.png' },
            { type: 'video', url: 'https://r2/movie.mp4' },
          ],
        }),
      },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });

  it('diverges when the talent was renamed mid-run', async () => {
    const dtoHash = await computeLibraryTalentSheetHashFromDto(baseInput);
    const stub: TalentStub = {
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          name: 'Alicia',
          description: 'Lead actress',
          media: [
            { type: 'image', url: 'https://r2/a.png' },
            { type: 'image', url: 'https://r2/b.png' },
          ],
        }),
      },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).not.toBe(currentHash);
  });

  it('diverges when the talent description was cleared mid-run', async () => {
    const dtoHash = await computeLibraryTalentSheetHashFromDto(baseInput);
    const stub: TalentStub = {
      talent: {
        getWithRelations: async () => ({
          id: 'tal1',
          name: 'Alice',
          description: null,
          media: [
            { type: 'image', url: 'https://r2/a.png' },
            { type: 'image', url: 'https://r2/b.png' },
          ],
        }),
      },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).not.toBe(currentHash);
  });

  it('falls back to the payload identity when the talent row vanished', async () => {
    const dtoHash = await computeLibraryTalentSheetHashFromDto(baseInput);
    const stub: TalentStub = {
      talent: { getWithRelations: async () => null },
    };
    const currentHash = await computeLibraryTalentSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });
});

describe('library-location-sheet hash', () => {
  const baseInput: LibraryLocationSheetWorkflowInput = {
    userId: 'u1',
    teamId: 't1',
    sequenceId: 'library',
    locationDbId: 'loc1',
    locationName: 'Rooftop Bar',
    locationDescription: 'Neon-lit, overlooking the harbour',
    referenceImageUrls: ['https://r2/a.png', 'https://r2/b.png'],
    imageModel: 'nano_banana_2',
  };

  it('FromDto matches Current when the live row still matches the payload', async () => {
    const dtoHash = await computeLibraryLocationSheetHashFromDto(baseInput);
    const stub: LibraryLocationStub = {
      locations: {
        getById: async () => ({
          id: 'loc1',
          name: 'Rooftop Bar',
          description: 'Neon-lit, overlooking the harbour',
        }),
      },
    };
    const currentHash = await computeLibraryLocationSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).toBe(currentHash);
  });

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

  it('diverges when the location was renamed mid-run', async () => {
    const dtoHash = await computeLibraryLocationSheetHashFromDto(baseInput);
    const stub: LibraryLocationStub = {
      locations: {
        getById: async () => ({
          id: 'loc1',
          name: 'Harbour Rooftop',
          description: 'Neon-lit, overlooking the harbour',
        }),
      },
    };
    const currentHash = await computeLibraryLocationSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).not.toBe(currentHash);
  });

  it('diverges when the description was cleared mid-run', async () => {
    const dtoHash = await computeLibraryLocationSheetHashFromDto(baseInput);
    const stub: LibraryLocationStub = {
      locations: {
        getById: async () => ({
          id: 'loc1',
          name: 'Rooftop Bar',
          description: null,
        }),
      },
    };
    const currentHash = await computeLibraryLocationSheetHashCurrent(
      baseInput,
      asScopedDb(stub)
    );
    expect(dtoHash).not.toBe(currentHash);
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
