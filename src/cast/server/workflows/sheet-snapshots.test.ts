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
  LibraryTalentSheetWorkflowInput,
  LocationSheetWorkflowInput,
} from '@/platform/server/workflow/types';
import type { SheetPayload } from './sheet-snapshots';
import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import type { TextToImageModel } from '@/models/models';
import { foldLegacyFeaturesInPayload } from '@/cast/bible-looks';
import {
  computeCharacterSheetHashFromDtoBefore2065,
  assertQueuedWithFace,
  characterSheetHashMatchesStored,
  computeCharacterSheetHashFromDto,
  queuedLegacyStyling,
  finishCharacterSheetPayload,
  computeLibraryTalentSheetHashFromDto,
  computeLocationSheetHashFromDto,
  computeStyleConfigHash,
  uploadedCharacterSheetHashMatchesStored,
  assertQueuedWithLocationRendering,
  locationSheetBibleFields,
  locationSheetHashMatchesStored,
  NO_LEGACY_LOCATION_SHEET,
  uploadedLocationSheetHashMatchesStored,
} from './sheet-snapshots';
import { computeLocationSheetInputHashLegacy } from '@/shots/input-hash';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import { PHOTOREAL_RENDERING } from '@/cast/rendering';
import { asStub } from '@/test/as-stub';
import { USER_UPLOAD_MODEL } from '@/shots/user-upload-model';

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
      rendering: 'Photoreal live action',
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
        stored,
        'no-style'
      ),
    };
    const run = foldLegacyFeaturesInPayload(queued);
    expect(run.lookStyling).toBe('hair up\nscar');
    expect(run.characterMetadata).not.toHaveProperty('distinguishingFeatures');
    // The folded payload still verifies, given the style it was stamped
    // with (a live verify supplies it; the run itself fails earlier, at
    // `assertQueuedWithRendering`).
    expect(
      await characterSheetHashMatchesStored(
        run.snapshotInputHash,
        run,
        queuedLegacyStyling(run),
        'no-style'
      )
    ).toBe(true);
    expect(
      await characterSheetHashMatchesStored(
        run.snapshotInputHash,
        { ...run, imageModel: 'flux_2_dev' },
        queuedLegacyStyling(run),
        null
      )
    ).toBe(false);
    // The sheet lands stamped with that hash, and a later live verify — the
    // stored parts off the rows, the styling as the look read resolves it —
    // reads it fresh.
    expect(
      await characterSheetHashMatchesStored(
        run.snapshotInputHash,
        { ...baseInput, lookStyling: 'hair up\nscar' },
        stored,
        'no-style'
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
        queuedLegacyStyling(current),
        'no-style'
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
  describe('an uploaded character sheet', () => {
    const legacy = { distinguishingFeatures: null, styling: null };
    const viewedWith = (imageModel: TextToImageModel) => ({
      ...baseInput,
      imageModel,
    });

    it('verifies from a sequence on any image model', async () => {
      const stamped = await computeCharacterSheetHashFromDto(
        viewedWith(asStub<TextToImageModel>(USER_UPLOAD_MODEL))
      );
      for (const model of ['nano_banana_2', 'krea_2_turbo'] as const) {
        expect(
          await uploadedCharacterSheetHashMatchesStored(
            stamped,
            viewedWith(model),
            legacy,
            null
          )
        ).toBe(true);
      }
    });

    it('stamped with its own sequence model still verifies from that sequence only', async () => {
      const stamped = await computeCharacterSheetHashFromDto(
        viewedWith('nano_banana_2')
      );
      const from = (model: TextToImageModel) =>
        uploadedCharacterSheetHashMatchesStored(
          stamped,
          viewedWith(model),
          legacy,
          null
        );
      expect(await from('nano_banana_2')).toBe(true);
      expect(await from('krea_2_turbo')).toBe(false);
    });
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
      rendering: PHOTOREAL_RENDERING,
      consistencyTag: 'docks',
      firstMention: { sceneId: '', text: '', lineNumber: 0 },
    },
    imageModel: 'nano_banana_2',
    referencePhotoUrls: ['https://r2/a.png', 'https://r2/b.png'],
  };

  it('moves with every bible field the prompt reads, rendering and the photos (#1785, #1695)', async () => {
    const base = await computeLocationSheetHashFromDto(baseInput);
    const relit = await computeLocationSheetHashFromDto({
      ...baseInput,
      locationMetadata: {
        ...baseInput.locationMetadata,
        keyFeatures: 'neon sign',
      },
    });
    const animated = await computeLocationSheetHashFromDto({
      ...baseInput,
      locationMetadata: {
        ...baseInput.locationMetadata,
        rendering: '3D animated, Pixar-like',
      },
    });
    const morePhotos = await computeLocationSheetHashFromDto({
      ...baseInput,
      referencePhotoUrls: [...baseInput.referencePhotoUrls, 'https://r2/c.png'],
    });
    expect(new Set([base, relit, animated, morePhotos]).size).toBe(4);
  });

  it('is the same from a sequence and from none, and in any photo order', async () => {
    const base = await computeLocationSheetHashFromDto(baseInput);
    expect(
      await computeLocationSheetHashFromDto({ ...baseInput, sequenceId: null })
    ).toBe(base);
    expect(
      await computeLocationSheetHashFromDto({
        ...baseInput,
        referencePhotoUrls: ['https://r2/b.png', 'https://r2/a.png'],
      })
    ).toBe(base);
  });

  it('treats a missing imageModel as DEFAULT_IMAGE_MODEL', async () => {
    expect(
      await computeLocationSheetHashFromDto({
        ...baseInput,
        imageModel: undefined,
      })
    ).toBe(
      await computeLocationSheetHashFromDto({
        ...baseInput,
        imageModel: DEFAULT_IMAGE_MODEL,
      })
    );
  });

  it("a run's own snapshot verifies with nothing legacy", async () => {
    expect(
      await locationSheetHashMatchesStored(
        await computeLocationSheetHashFromDto(baseInput),
        baseInput,
        NO_LEGACY_LOCATION_SHEET
      )
    ).toBe(true);
  });

  it('refuses a payload queued before the bible carried rendering or the photos', () => {
    expect(() => assertQueuedWithLocationRendering(baseInput)).not.toThrow();
    const { rendering: _rendering, ...noRendering } =
      baseInput.locationMetadata;
    expect(() =>
      assertQueuedWithLocationRendering({
        ...baseInput,
        locationMetadata: noRendering,
      })
    ).toThrow('Run it again');
    const { referencePhotoUrls: _photos, ...noPhotos } = baseInput;
    expect(() => assertQueuedWithLocationRendering(noPhotos)).toThrow(
      'Run it again'
    );
  });

  describe('a sheet stamped before #1695', () => {
    const styleOf = (mood: string) =>
      migrateStyleConfigV1ToV2({
        mood,
        artStyle: 'Stylized 3D animation',
        lighting: 'Soft',
        colorPalette: ['#FF6B6B'],
        cameraWork: 'Smooth dollies',
        referenceFilms: [],
        colorGrading: 'Warm',
      });
    const style = styleOf('Whimsical');
    const otherStyle = styleOf('Bleak');
    const hashInput = {
      locationBible: locationSheetBibleFields(baseInput.locationMetadata),
      referencePhotoHashes: baseInput.referencePhotoUrls,
      imageModel: 'nano_banana_2',
    };
    const stampedWith = async (kind: 'pre-1695' | 'library') =>
      computeLocationSheetInputHashLegacy(hashInput, kind, {
        libraryLocationReferenceHash: 'lib-v1',
        styleConfigHash: await computeStyleConfigHash(style),
        unstyledConfigHash: await computeStyleConfigHash(null),
      });

    it('still reads fresh from its own sequence', async () => {
      expect(
        await locationSheetHashMatchesStored(
          await stampedWith('pre-1695'),
          baseInput,
          { libraryLocationReferenceHash: 'lib-v1', styleConfig: style }
        )
      ).toBe(true);
    });

    it('reads stale from a sequence of another style, and from no sequence', async () => {
      const stored = await stampedWith('pre-1695');
      expect(
        await locationSheetHashMatchesStored(stored, baseInput, {
          libraryLocationReferenceHash: 'lib-v1',
          styleConfig: otherStyle,
        })
      ).toBe(false);
      expect(
        await locationSheetHashMatchesStored(stored, baseInput, {
          libraryLocationReferenceHash: 'lib-v1',
          styleConfig: null,
        })
      ).toBe(false);
    });

    it('reads stale when the library reference it names is not the stored one', async () => {
      expect(
        await locationSheetHashMatchesStored(
          await stampedWith('pre-1695'),
          baseInput,
          { libraryLocationReferenceHash: null, styleConfig: style }
        )
      ).toBe(false);
    });

    it("a library location's sheet reads fresh from every sequence and from none", async () => {
      const stored = await stampedWith('library');
      for (const styleConfig of [style, otherStyle, null]) {
        expect(
          await locationSheetHashMatchesStored(stored, baseInput, {
            libraryLocationReferenceHash: null,
            styleConfig,
          })
        ).toBe(true);
      }
    });
  });

  describe('an uploaded location sheet', () => {
    const viewedWith = (imageModel: TextToImageModel) => ({
      ...baseInput,
      imageModel,
    });

    it('verifies from a sequence on any image model', async () => {
      const stamped = await computeLocationSheetHashFromDto(
        viewedWith(asStub<TextToImageModel>(USER_UPLOAD_MODEL))
      );
      for (const model of ['nano_banana_2', 'krea_2_turbo'] as const) {
        expect(
          await uploadedLocationSheetHashMatchesStored(
            stamped,
            viewedWith(model),
            NO_LEGACY_LOCATION_SHEET
          )
        ).toBe(true);
      }
    });

    it('stamped with its own sequence model still verifies from that sequence only', async () => {
      const stamped = await computeLocationSheetHashFromDto(
        viewedWith('nano_banana_2')
      );
      const from = (model: TextToImageModel) =>
        uploadedLocationSheetHashMatchesStored(
          stamped,
          viewedWith(model),
          NO_LEGACY_LOCATION_SHEET
        );
      expect(await from('nano_banana_2')).toBe(true);
      expect(await from('krea_2_turbo')).toBe(false);
    });

    it('moves with a bible edit', async () => {
      const stamped = await computeLocationSheetHashFromDto(
        viewedWith(asStub<TextToImageModel>(USER_UPLOAD_MODEL))
      );
      expect(
        await uploadedLocationSheetHashMatchesStored(
          stamped,
          {
            ...baseInput,
            locationMetadata: {
              ...baseInput.locationMetadata,
              description: 'Dry dock',
            },
          },
          NO_LEGACY_LOCATION_SHEET
        )
      ).toBe(false);
    });
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
