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
import { foldLegacyFeaturesInPayload } from '@/cast/bible-looks';
import {
  assertQueuedWithFace,
  characterSheetHashMatchesStored,
  computeCharacterSheetHashFromDto,
  computeCharacterSheetHashFromDtoBefore2065,
  queuedLegacyStyling,
  finishCharacterSheetPayload,
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
    lookId: 'c1',
    lookVersionId: 'c1',
    lookStyling: null,
    face: null,
    talentId: null,
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
      looks: [],
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

  it('hashes the face a look is drawn from; the default look carries none', async () => {
    const plain = await computeCharacterSheetHashFromDto(baseInput);
    const faced = await computeCharacterSheetHashFromDto({
      ...baseInput,
      face: { url: '/r2/jack.png', versionId: 'sheet-v1' },
    });
    const movedUrlOnly = await computeCharacterSheetHashFromDto({
      ...baseInput,
      face: { url: '/r2/other.png', versionId: 'sheet-v1' },
    });
    expect(faced).not.toBe(plain);
    // The version is the identity: the url is where the run fetches it.
    expect(movedUrlOnly).toBe(faced);
  });

  it('4e: a sheet run queued before #2065 folds at the payload seam and still passes its own snapshot check', async () => {
    // As queued: the features on the bible entry, the look's own styling
    // beside it, and a snapshot hash stamped from the two.
    const stored = { distinguishingFeatures: 'scar', styling: 'hair up' };
    const queued = {
      ...baseInput,
      lookStyling: stored.styling,
      characterMetadata: {
        ...baseInput.characterMetadata,
        distinguishingFeatures: stored.distinguishingFeatures,
      },
      snapshotInputHash: await computeCharacterSheetHashFromDtoBefore2065(
        baseInput,
        stored
      ),
    };
    const run = foldLegacyFeaturesInPayload(queued);
    expect(run.lookStyling).toBe('hair up\nscar');
    expect(run.characterMetadata).not.toHaveProperty('distinguishingFeatures');
    // The run's tamper check, on the folded payload.
    expect(
      await characterSheetHashMatchesStored(
        run.snapshotInputHash,
        run,
        queuedLegacyStyling(run)
      )
    ).toBe(true);
    expect(
      await characterSheetHashMatchesStored(
        run.snapshotInputHash,
        { ...run, imageModel: 'flux_2_dev' },
        queuedLegacyStyling(run)
      )
    ).toBe(false);
    // The sheet lands stamped with that hash, and a later live verify — the
    // stored parts off the rows, the styling as the look read resolves it —
    // reads it fresh.
    expect(
      await characterSheetHashMatchesStored(
        run.snapshotInputHash,
        { ...baseInput, lookStyling: 'hair up\nscar' },
        stored
      )
    ).toBe(true);
    // A payload of the current shape checks against its own current stamp.
    const current = {
      ...baseInput,
      lookStyling: 'hair up\nscar',
      snapshotInputHash: await computeCharacterSheetHashFromDto({
        ...baseInput,
        lookStyling: 'hair up\nscar',
      }),
    };
    expect(foldLegacyFeaturesInPayload(current)).toEqual(current);
    expect(
      await characterSheetHashMatchesStored(
        current.snapshotInputHash,
        current,
        queuedLegacyStyling(current)
      )
    ).toBe(true);
  });

  it('refuses a payload queued before every look carried a face', () => {
    const { face: _face, ...queuedBefore } = baseInput;
    expect(() => assertQueuedWithFace(queuedBefore)).toThrow(
      'Queued before looks were drawn from the default look. Run it again.'
    );
    expect(() => assertQueuedWithFace(baseInput)).not.toThrow();
  });

  it('finishes a draft with its face and the hash that covers it', async () => {
    const { face: _face, ...draft } = baseInput;
    const face = { url: '/r2/jack.png', versionId: 'sheet-v1' };
    const finished = await finishCharacterSheetPayload(draft, face);
    expect(finished.face).toEqual(face);
    expect(finished.snapshotInputHash).toBe(
      await computeCharacterSheetHashFromDto({ ...baseInput, face })
    );
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
      description: 'Foggy waterfront',
      architecturalStyle: '',
      keyFeatures: '',
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
        keyFeatures: 'neon sign',
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
