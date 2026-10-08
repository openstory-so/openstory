import { describe, expect, expectTypeOf, it } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/look/style-config';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
  Scene,
} from './scene-analysis.schema';
import type { StyleConfig } from '@/platform/server/db/schema';
import type { MusicSceneSummary } from '@/platform/server/workflow/types';
import {
  characterSheetInputHashMatches,
  computeCharacterSheetInputHash,
  computeCharacterSheetInputHashLegacy,
  computeShotImageInputHash,
  computeLibraryLocationReferenceInputHash,
  computeLocationSheetInputHash,
  hashMotionPromptInput,
  computeMotionPromptInputHashV4,
  computeMusicPromptInputHash,
  LEGACY_HASH_UNTIL,
  computeSequenceMusicInputHash,
  computeTalentSheetInputHash,
  computeTalentSheetInputHashLegacy,
  assembleMotionPromptHashInput,
  hashVisualPromptInput,
  computeVisualPromptInputHashV4,
  motionPromptInputHashMatches,
  sha256Hex,
  visualPromptInputHashMatches,
  voiceOnlyMovedSince,
  type CharacterSheetHashInput,
  type LegacyStylingByCharacter,
  type LegacyStylingParts,
  type MotionPromptHashInput,
  type MotionPromptInputHash,
  type ShotImageHashInput,
  type LibraryLocationReferenceHashInput,
  type LocationSheetHashInput,
  type TalentSheetHashInput,
} from './input-hash';
import { effectiveStyling } from '@/cast/character-looks';
import { deriveShotDialogueLines, shotDialogue } from './shot-dialogue';
import { sceneForShot } from './server/shot-work-items';
import { asStub } from '@/test/as-stub';

const baseThumbnail: ShotImageHashInput = {
  kind: 'thumbnail',
  visualPrompt: 'A detective in a rainy alley, neon reflections',
  imageModel: 'flux-pro-v1.1',
  aspectRatio: '16:9',
  size: '1920x1080',
  seed: 42,
  characterSheetHashes: ['char-a', 'char-b'],
  locationSheetHashes: ['loc-1'],
  elementReferenceHashes: ['el-x'],
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Incomplete assembler payload for "omitted field throws" tests. */
// test-only incomplete DTO
const incomplete = <T>(value: object): T => asStub<T>(value);

/** No character's voice-only flag moved since the stamp. */
/** No legacy features, no styling: the parts of the plain `c1` fixtures. */
const BLANK_PARTS: LegacyStylingParts = {
  distinguishingFeatures: null,
  styling: null,
};
const BLANK_LEGACY: LegacyStylingByCharacter = { c1: BLANK_PARTS };
const VOICE_STILL = { voiceOnlyMoved: false, legacyStyling: BLANK_LEGACY };

describe('computeShotImageInputHash (thumbnail)', () => {
  it('produces a 64-char hex SHA-256 digest', async () => {
    const hash = await computeShotImageInputHash(baseThumbnail);
    expect(hash).toMatch(SHA256_HEX);
  });

  it('returns the same hash for identical input', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({ ...baseThumbnail });
    expect(a).toBe(b);
  });

  it('is order-insensitive for character sheet refs', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-b', 'char-a'],
    });
    expect(a).toBe(b);
  });

  it('trims free-text prompts', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      visualPrompt: `   ${baseThumbnail.visualPrompt}\n`,
    });
    expect(a).toBe(b);
  });

  it('changes when the visual prompt changes', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      visualPrompt: `${baseThumbnail.visualPrompt} at dawn`,
    });
    expect(a).not.toBe(b);
  });

  it('changes when the image model version changes', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      imageModel: 'flux-pro-v1.2',
    });
    expect(a).not.toBe(b);
  });

  it('changes when the aspect ratio, size, or seed changes', async () => {
    const base = await computeShotImageInputHash(baseThumbnail);
    const aspect = await computeShotImageInputHash({
      ...baseThumbnail,
      aspectRatio: '9:16',
    });
    const size = await computeShotImageInputHash({
      ...baseThumbnail,
      size: '1280x720',
    });
    const seed = await computeShotImageInputHash({
      ...baseThumbnail,
      seed: 99,
    });
    expect(new Set([base, aspect, size, seed]).size).toBe(4);
  });

  it('changes when a referenced character sheet hash changes', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const b = await computeShotImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-a', 'char-b-NEW'],
    });
    expect(a).not.toBe(b);
  });

  it('changes when location or element refs change', async () => {
    const a = await computeShotImageInputHash(baseThumbnail);
    const loc = await computeShotImageInputHash({
      ...baseThumbnail,
      locationSheetHashes: ['loc-2'],
    });
    const el = await computeShotImageInputHash({
      ...baseThumbnail,
      elementReferenceHashes: ['el-y'],
    });
    expect(new Set([a, loc, el]).size).toBe(3);
  });

  it('rejects omitted size/seed; null is the explicit empty', async () => {
    const explicitNulls = await computeShotImageInputHash({
      ...baseThumbnail,
      size: null,
      seed: null,
    });
    expect(() =>
      computeShotImageInputHash(
        incomplete<ShotImageHashInput>({
          kind: baseThumbnail.kind,
          visualPrompt: baseThumbnail.visualPrompt,
          imageModel: baseThumbnail.imageModel,
          aspectRatio: baseThumbnail.aspectRatio,
          characterSheetHashes: baseThumbnail.characterSheetHashes,
          locationSheetHashes: baseThumbnail.locationSheetHashes,
          elementReferenceHashes: baseThumbnail.elementReferenceHashes,
        })
      )
    ).toThrow();
    expect(explicitNulls).toMatch(SHA256_HEX);
  });
});

describe('computeShotImageInputHash (variant-image)', () => {
  it('is distinct from the thumbnail hash for the same input', async () => {
    const thumb = await computeShotImageInputHash(baseThumbnail);
    const variant = await computeShotImageInputHash({
      ...baseThumbnail,
      kind: 'variant-image',
    });
    expect(variant).toMatch(SHA256_HEX);
    expect(variant).not.toBe(thumb);
  });

  it('is stable and sensitive to model change', async () => {
    const variantBase: ShotImageHashInput = {
      ...baseThumbnail,
      kind: 'variant-image',
    };
    const a = await computeShotImageInputHash(variantBase);
    const same = await computeShotImageInputHash({ ...variantBase });
    const different = await computeShotImageInputHash({
      ...variantBase,
      imageModel: 'sdxl-v1',
    });
    expect(a).toBe(same);
    expect(a).not.toBe(different);
  });
});

describe('computeCharacterSheetInputHash', () => {
  const base: CharacterSheetHashInput = {
    characterBible: {
      name: 'Detective Sarah',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'tall, blonde, blue eyes',
      standardClothing: 'dark trench coat',
      consistencyTag: 'sarah_blonde_30s',
    },
    styling: null,
    faceSheetVersionId: null,
    talentSheetHash: 'talent-sha',
    talent: null,
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('is stable and sensitive to visual bible field changes, not a rename', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const same = await computeCharacterSheetInputHash({ ...base });
    const renamed = await computeCharacterSheetInputHash({
      ...base,
      characterBible: { ...base.characterBible, name: 'Detective Linda' },
    });
    const look = await computeCharacterSheetInputHash({
      ...base,
      characterBible: {
        ...base.characterBible,
        physicalDescription: 'short, dark hair',
      },
    });
    expect(a).toBe(same);
    expect(a).toBe(renamed);
    expect(a).not.toBe(look);

    const named = await computeCharacterSheetInputHashLegacy(base, BLANK_PARTS);
    expect(named).not.toBe(a);
    expect(await characterSheetInputHashMatches(named, base, BLANK_PARTS)).toBe(
      true
    );
    expect(
      await characterSheetInputHashMatches(
        a,
        {
          ...base,
          characterBible: { ...base.characterBible, name: 'Detective Linda' },
        },
        BLANK_PARTS
      )
    ).toBe(true);
    expect(
      await characterSheetInputHashMatches(
        named,
        {
          ...base,
          characterBible: {
            ...base.characterBible,
            physicalDescription: 'short, dark hair',
          },
        },
        BLANK_PARTS
      )
    ).toBe(false);
  });

  it('hashes the default look’s sheet version only once a look is drawn from it', async () => {
    // The default look carries none, and neither did any digest before.
    const plain = await computeCharacterSheetInputHash(base);

    const faced = await computeCharacterSheetInputHash({
      ...base,
      faceSheetVersionId: 'sheet-v1',
    });
    const moved = await computeCharacterSheetInputHash({
      ...base,
      faceSheetVersionId: 'sheet-v2',
    });
    expect(faced).not.toBe(plain);
    expect(moved).not.toBe(faced);
    // Every digest shape carries the face, so a sheet stamped without it
    // does not stay fresh once the default sheet exists.
    expect(
      await characterSheetInputHashMatches(
        plain,
        {
          ...base,
          faceSheetVersionId: 'sheet-v1',
        },
        BLANK_PARTS
      )
    ).toBe(false);
    expect(
      await characterSheetInputHashMatches(
        faced,
        {
          ...base,
          faceSheetVersionId: 'sheet-v1',
        },
        BLANK_PARTS
      )
    ).toBe(true);
    const named = await computeCharacterSheetInputHashLegacy(base, BLANK_PARTS);
    expect(
      await characterSheetInputHashMatches(
        named,
        {
          ...base,
          faceSheetVersionId: 'sheet-v1',
        },
        BLANK_PARTS
      )
    ).toBe(false);
  });

  it('reacts to talent hash, style config, and image model', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const talent = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: 'talent-sha-v2',
    });
    const style = await computeCharacterSheetInputHash({
      ...base,
      styleConfigHash: 'style-sha-v2',
    });
    const model = await computeCharacterSheetInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(new Set([a, talent, style, model]).size).toBe(4);
  });

  it('a cast talent edit re-stales the sheet; pre-#1785 digests still verify (#1785)', async () => {
    const cast: CharacterSheetHashInput = {
      ...base,
      talent: {
        description: 'Freckles, auburn hair',
        sheetImageUrl: '/r2/talent/sheet-1.png',
        sheetLook: {
          age: '30s',
          gender: 'female',
          ethnicity: '',
          physicalDescription: 'auburn hair',
        },
      },
    };
    const a = await computeCharacterSheetInputHash(cast);
    const talent = cast.talent;
    if (!talent?.sheetLook) throw new Error('fixture is cast');
    const edits = await Promise.all(
      [
        { ...talent, description: 'Freckles, grey hair' },
        { ...talent, sheetImageUrl: '/r2/talent/sheet-2.png' },
        {
          ...talent,
          sheetLook: { ...talent.sheetLook, physicalDescription: 'grey' },
        },
      ].map((t) => computeCharacterSheetInputHash({ ...cast, talent: t }))
    );
    expect(new Set([a, ...edits]).size).toBe(4);
    // Uncast digests do not move, and a sheet stamped before the talent
    // channel existed still verifies until LEGACY_HASH_UNTIL.
    expect(await computeCharacterSheetInputHash(base)).not.toBe(a);
    const preTalent = await computeCharacterSheetInputHashLegacy(
      base,
      BLANK_PARTS,
      'pre-1785'
    );
    expect(
      await characterSheetInputHashMatches(preTalent, cast, BLANK_PARTS)
    ).toBe(true);
  });

  it('does not fold isPerson into the sheet hash (#1682)', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const flagged = await computeCharacterSheetInputHash({
      ...base,
      characterBible: {
        ...base.characterBible,
        isPerson: false,
      },
    });
    expect(flagged).toBe(a);
  });

  describe('looks (#2015)', () => {
    // What the pre-#2015 hasher stamped for `base` — the bible feeding
    // `standardClothing` — uncast and cast. Computed from the hasher as it
    // stood before looks; a sheet in production carries digests like these.
    const STAMPED_UNCAST =
      'dabf0070f773be94373d504301941eea66b1e8ec992b472901151f3d99a5c54c';
    const STAMPED_CAST =
      'fa5b8e2b4f453a14df6000d93f2ca9ddc31998542c57b55a5e1ca85616c8850f';
    const castTalent = {
      description: 'A weathered sailor',
      sheetImageUrl: '/r2/talent/sheet.png',
      sheetLook: {
        age: '40s',
        gender: 'female',
        ethnicity: null,
        physicalDescription: 'broad',
      },
    };

    // `base` with the features text the bible held then (#2065).
    const FEATURES = 'scar above right eye';

    it('4a: a backfilled default look verifies against the digest its sheet was stamped with', async () => {
      // The backfill copies the bible's clothing onto the look verbatim and
      // leaves `styling` NULL; the look now feeds `standardClothing`, and
      // its styling is its own joined with the bible's features.
      const stored = { distinguishingFeatures: FEATURES, styling: null };
      const fromLook: CharacterSheetHashInput = {
        ...base,
        characterBible: {
          ...base.characterBible,
          standardClothing: 'dark trench coat',
        },
        styling: effectiveStyling(
          stored.styling,
          stored.distinguishingFeatures
        ),
      };
      expect(
        await computeCharacterSheetInputHashLegacy(fromLook, stored, 'pre-2065')
      ).toBe(STAMPED_UNCAST);
      expect(
        await computeCharacterSheetInputHashLegacy(
          { ...fromLook, talent: castTalent },
          stored,
          'pre-2065'
        )
      ).toBe(STAMPED_CAST);
      expect(
        await characterSheetInputHashMatches(STAMPED_UNCAST, fromLook, stored)
      ).toBe(true);
      expect(
        await characterSheetInputHashMatches(
          STAMPED_CAST,
          { ...fromLook, talent: castTalent },
          stored
        )
      ).toBe(true);
      // 4b: a sheet drawn now is stamped in the new shape, and verifies.
      const stamped = await computeCharacterSheetInputHash(fromLook);
      expect(stamped).not.toBe(STAMPED_UNCAST);
      expect(
        await characterSheetInputHashMatches(stamped, fromLook, stored)
      ).toBe(true);
      // 4d: an edit to the age stales the old sheet, as it did.
      expect(
        await characterSheetInputHashMatches(
          STAMPED_UNCAST,
          {
            ...fromLook,
            characterBible: { ...fromLook.characterBible, age: '40s' },
          },
          stored
        )
      ).toBe(false);
      // 4b: the styling edit that moves the text stales it too.
      expect(
        await characterSheetInputHashMatches(
          STAMPED_UNCAST,
          { ...fromLook, styling: 'hair down' },
          { distinguishingFeatures: null, styling: 'hair down' }
        )
      ).toBe(false);
    });

    it('4a: a default look with styling, and another look, verify against their pre-#2065 digests', async () => {
      // Stamped by the hasher as it stood before #2065.
      const STAMPED_STYLED =
        '071a67b13fca9a78c92c24352a7809c3f9d3d7b702a43de12855de4feb301167';
      const STAMPED_OTHER_LOOK =
        '847e3202220d032e9f70093c3060bc819d169c355d55fe72597a7d03b247e78c';
      const styled = {
        distinguishingFeatures: FEATURES,
        styling: 'hair pinned up',
      };
      expect(
        await characterSheetInputHashMatches(
          STAMPED_STYLED,
          {
            ...base,
            styling: effectiveStyling(
              styled.styling,
              styled.distinguishingFeatures
            ),
          },
          styled
        )
      ).toBe(true);
      // A look other than the default: its styling is its own, and the
      // features it was stamped with are still on the bible version.
      const other = { distinguishingFeatures: FEATURES, styling: 'split lip' };
      const gala: CharacterSheetHashInput = {
        ...base,
        characterBible: {
          ...base.characterBible,
          standardClothing: 'gala gown',
        },
        styling: 'split lip',
        faceSheetVersionId: 'sheet-v1',
      };
      expect(
        await characterSheetInputHashMatches(STAMPED_OTHER_LOOK, gala, other)
      ).toBe(true);
      // Its new stamp does not read the features at all.
      expect(await computeCharacterSheetInputHash(gala)).toBe(
        await computeCharacterSheetInputHash({ ...gala })
      );
      expect(
        await characterSheetInputHashMatches(
          await computeCharacterSheetInputHash(gala),
          gala,
          { distinguishingFeatures: null, styling: 'split lip' }
        )
      ).toBe(true);
    });

    it('adds styling to the digest only when it is set', async () => {
      const none = await computeCharacterSheetInputHash(base);
      for (const blank of ['', '   ']) {
        expect(
          await computeCharacterSheetInputHash({ ...base, styling: blank })
        ).toBe(none);
      }
      const bruised = await computeCharacterSheetInputHash({
        ...base,
        styling: 'split lip, hair down',
      });
      expect(bruised).not.toBe(none);
      expect(
        await characterSheetInputHashMatches(
          none,
          {
            ...base,
            styling: 'split lip, hair down',
          },
          BLANK_PARTS
        )
      ).toBe(false);
      // An edit to the styling moves it again.
      expect(
        await computeCharacterSheetInputHash({ ...base, styling: 'hair up' })
      ).not.toBe(bruised);
    });

    it('moves with the clothing of the look', async () => {
      expect(
        await computeCharacterSheetInputHash({
          ...base,
          characterBible: { ...base.characterBible, standardClothing: 'gown' },
        })
      ).not.toBe(STAMPED_UNCAST);
    });
  });

  it('rejects omitted talentSheetHash; null is the explicit empty', async () => {
    const nullHash = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: null,
    });
    expect(() =>
      computeCharacterSheetInputHash(
        incomplete<CharacterSheetHashInput>({
          characterBible: base.characterBible,
          styling: null,
          styleConfigHash: base.styleConfigHash,
          imageModel: base.imageModel,
        })
      )
    ).toThrow();
    expect(nullHash).toMatch(SHA256_HEX);
  });
});

describe('computeLocationSheetInputHash', () => {
  const base: LocationSheetHashInput = {
    locationBible: {
      name: 'Office',
      description: 'Modern open-plan, glass',
      type: 'interior',
      architecturalStyle: 'modernist',
      keyFeatures: 'standing desks',
      ambiance: 'busy',
    },
    libraryLocationReferenceHash: 'lib-sha',
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('reacts to bible, library ref, style, and model', async () => {
    const a = await computeLocationSheetInputHash(base);
    const variants = await Promise.all([
      computeLocationSheetInputHash({
        ...base,
        locationBible: {
          ...base.locationBible,
          description: 'Warehouse, bare concrete',
        },
      }),
      computeLocationSheetInputHash({
        ...base,
        libraryLocationReferenceHash: 'lib-sha-v2',
      }),
      computeLocationSheetInputHash({
        ...base,
        styleConfigHash: 'style-sha-v2',
      }),
      computeLocationSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(new Set([a, ...variants]).size).toBe(5);
  });

  it('every bible field the sheet prompt reads re-stales it (#1785)', async () => {
    const a = await computeLocationSheetInputHash(base);
    const edits = await Promise.all(
      (
        [
          ['type', 'exterior'],
          ['architecturalStyle', 'brutalist'],
          ['keyFeatures', 'a single long table'],
          ['ambiance', 'deserted'],
        ] as const
      ).map(([field, value]) =>
        computeLocationSheetInputHash({
          ...base,
          locationBible: { ...base.locationBible, [field]: value },
        })
      )
    );
    expect(new Set([a, ...edits]).size).toBe(5);
  });

  it('a location rename does not change the sheet hash', async () => {
    const a = await computeLocationSheetInputHash(base);
    const renamed = await computeLocationSheetInputHash({
      ...base,
      locationBible: { ...base.locationBible, name: 'Warehouse' },
    });
    expect(renamed).toBe(a);
  });
});

describe('computeLibraryLocationReferenceInputHash', () => {
  const base: LibraryLocationReferenceHashInput = {
    locationBible: { name: 'Office', description: 'Modern open-plan, glass' },
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
    referenceMediaHashes: [],
  };

  it('is stable, distinct from sheet hash, and reacts to model', async () => {
    const ref = await computeLibraryLocationReferenceInputHash(base);
    const refSame = await computeLibraryLocationReferenceInputHash({ ...base });
    const sheetEquivalent = await computeLocationSheetInputHash({
      ...base,
      locationBible: {
        ...base.locationBible,
        type: 'interior',
        architecturalStyle: '',
        keyFeatures: '',
        ambiance: '',
      },
      libraryLocationReferenceHash: null,
    });
    const refModel = await computeLibraryLocationReferenceInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(ref).toBe(refSame);
    expect(ref).not.toBe(sheetEquivalent);
    expect(ref).not.toBe(refModel);
    expect(() =>
      computeLibraryLocationReferenceInputHash(
        incomplete<LibraryLocationReferenceHashInput>({
          locationBible: base.locationBible,
          styleConfigHash: base.styleConfigHash,
          imageModel: base.imageModel,
        })
      )
    ).toThrow();
  });
});

describe('computeTalentSheetInputHash', () => {
  const base: TalentSheetHashInput = {
    talent: { name: 'Talent Name', description: 'Headshot reference' },
    referenceMediaHashes: ['m1', 'm2', 'm3'],
    imageModel: 'flux-pro-v1.1',
  };

  it('is order-insensitive for reference media', async () => {
    const a = await computeTalentSheetInputHash(base);
    const b = await computeTalentSheetInputHash({
      ...base,
      referenceMediaHashes: ['m3', 'm1', 'm2'],
    });
    expect(a).toBe(b);
  });

  it('reacts to description, media set, and image model, not a rename', async () => {
    const a = await computeTalentSheetInputHash(base);
    const renamed = await computeTalentSheetInputHash({
      ...base,
      talent: { ...base.talent, name: 'Other Talent' },
    });
    const variants = await Promise.all([
      computeTalentSheetInputHash({
        ...base,
        talent: { ...base.talent, description: 'Full body reference' },
      }),
      computeTalentSheetInputHash({
        ...base,
        referenceMediaHashes: ['m1', 'm2', 'm4'],
      }),
      computeTalentSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(renamed).toBe(a);
    expect(new Set([a, ...variants]).size).toBe(4);
  });

  it('the pre-drop named talent digest differs from the current one', async () => {
    const named = await computeTalentSheetInputHashLegacy(base);
    expect(named).not.toBe(await computeTalentSheetInputHash(base));
  });
});

describe('canonical serialization', () => {
  it('produces the same digest regardless of key insertion order', async () => {
    const ordered = await computeCharacterSheetInputHash({
      characterBible: {
        name: 'Alice',
        age: '30s',
        gender: 'female',
        ethnicity: '',
        physicalDescription: 'tall',
        standardClothing: 'jacket',
        consistencyTag: 'alice_30s',
      },
      styling: null,
      faceSheetVersionId: null,
      talentSheetHash: 'talent',
      talent: null,
      styleConfigHash: 'style',
      imageModel: 'flux-pro',
    });
    // Same fields, declared in a different order at every level.
    const shuffled = await computeCharacterSheetInputHash({
      imageModel: 'flux-pro',
      styleConfigHash: 'style',
      styling: null,
      faceSheetVersionId: null,
      talentSheetHash: 'talent',
      talent: null,
      characterBible: {
        consistencyTag: 'alice_30s',
        standardClothing: 'jacket',
        physicalDescription: 'tall',
        ethnicity: '',
        gender: 'female',
        age: '30s',
        name: 'Alice',
      },
    });
    expect(ordered).toBe(shuffled);
  });

  it('rejects non-finite numbers rather than collapsing them to null', async () => {
    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        computeSequenceMusicInputHash({
          prompt: 'test',
          tags: '',
          durationSeconds,
          audioModel: 'cassette-v1',
        })
      ).toThrow();
    }
  });
});

describe('prompt input hashes', () => {
  const minimalScene: Scene = {
    sceneId: 's1',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
  };

  const minimalStyle: StyleConfig = migrateStyleConfigV1ToV2({
    mood: 'neutral',
    artStyle: 'cinematic',
    lighting: 'natural',
    colorPalette: ['neutral'],
    cameraWork: 'static',
    referenceFilms: [],
    colorGrading: 'neutral',
  });

  const aliceCharacter: CharacterBibleEntry = {
    characterId: 'c1',
    name: 'Alice',
    age: '30',
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
    consistencyTag: '',
  };

  it("reads the worn look's styling only when it is set, so a prompt stamped before looks stays fresh (#2015)", async () => {
    const hashOf = (character: CharacterBibleEntry) =>
      Promise.all([
        hashVisualPromptInput({ ...sceneCtx, characterBible: [character] }),
        hashMotionPromptInput({ ...sceneCtx, characterBible: [character] }),
      ]);
    const look = (styling: string, clothing = '') => ({
      lookId: 'L1',
      name: 'Default',
      clothing,
      styling,
    });
    // An entry stored before #2015 has no `looks` key at all.
    const { looks: _looks, ...stored } = aliceCharacter;
    const before = await hashOf(asStub<CharacterBibleEntry>(stored));
    expect(await hashOf(aliceCharacter)).toEqual(before);
    expect(await hashOf({ ...aliceCharacter, looks: [look('  ')] })).toEqual(
      before
    );
    // Another look the character owns but is not wearing moves nothing.
    expect(
      await hashOf({
        ...aliceCharacter,
        looks: [look(''), { ...look('split lip', 'gown'), lookId: 'L2' }],
      })
    ).toEqual(before);

    const styled = await hashOf({
      ...aliceCharacter,
      looks: [look('split lip')],
    });
    expect(styled[0]).not.toBe(before[0]);
    expect(styled[1]).not.toBe(before[1]);
  });

  const beachLocation: LocationBibleEntry = {
    locationId: 'l1',
    name: 'Beach',
    type: 'exterior',
    description: '',
    architecturalStyle: '',
    keyFeatures: '',
    ambiance: '',
    consistencyTag: '',
    firstMention: { sceneId: '', text: '', lineNumber: 0 },
  };

  const sceneCtx = {
    scene: minimalScene,
    styleConfig: minimalStyle,
    characterBible: [aliceCharacter],
    locationBible: [beachLocation],
    elementBible: [],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
    startingFrameImageUrl: null,
    referenceOnly: false,
    dialogue: { presence: false, lines: [] },
  };
  /** A shot whose lines sit on its dialogue node. */
  const NODE = { legacyScriptDialogue: false, ...VOICE_STILL };

  describe('the default look owns the features (#2065)', () => {
    // What the hasher stamped before #2065 for Alice with the features text
    // on her bible and each look's own styling. Computed from the hasher as
    // it stood then; prompts in production carry digests like these.
    const FEATURES = 'scar above right eye';
    const office = (styling: string) => ({
      lookId: 'L1',
      name: 'Default',
      clothing: 'coat',
      styling,
    });
    const gala = {
      lookId: 'L2',
      name: 'Gala',
      clothing: 'gown',
      styling: 'split lip',
    };
    const cases = [
      {
        name: 'the default look, with styling of its own',
        // As a look read resolves it now: its own, then the features.
        worn: office(effectiveStyling('hair pinned up', FEATURES) ?? ''),
        rest: [gala],
        stored: { distinguishingFeatures: FEATURES, styling: 'hair pinned up' },
        visual:
          '7afe69f3535c17323ef3e8c3d111aa9bab3827fd7a27cfe0a9d15b594ee6a3ad',
        motion:
          '2aacf26222ea3c1cb2bae300bc72ba291de9872c1e61d5d1870c1099924f6e2e',
      },
      {
        name: 'the default look, with no styling of its own',
        worn: office(effectiveStyling('', FEATURES) ?? ''),
        rest: [gala],
        stored: { distinguishingFeatures: FEATURES, styling: '' },
        visual:
          'b3265d0b4d76720a24a2383fb0efb2cc0ac19821658413a9930d6b49461bfda8',
        motion:
          '6a87f51fe0e087969fba157d1ab090854f6c3750a2091192f0c982b5f1f89be2',
      },
      {
        name: 'another look, which no longer reads the features',
        worn: gala,
        rest: [office('hair pinned up')],
        stored: { distinguishingFeatures: FEATURES, styling: 'split lip' },
        visual:
          'bb1afc567b398c736f33614425fc01d909a55de62cc6d33d311efa93acb0b659',
        motion:
          'f3894cc088b68c2862038d709236af661b0106677991fcb513ec43eef8c7aad8',
      },
    ];

    it('joins the features to the default look’s own styling, once', () => {
      expect(effectiveStyling('hair pinned up', FEATURES)).toBe(
        `hair pinned up\n${FEATURES}`
      );
      expect(effectiveStyling(null, FEATURES)).toBe(FEATURES);
      expect(effectiveStyling('hair pinned up', null)).toBe('hair pinned up');
      expect(effectiveStyling(null, '  ')).toBeNull();
      // A look version already written from the effective text, read beside
      // a bible version that still holds the features.
      expect(effectiveStyling(`hair pinned up\n${FEATURES}`, FEATURES)).toBe(
        `hair pinned up\n${FEATURES}`
      );
    });

    it.each(cases)(
      '4a: a prompt stamped before #2065 verifies as fresh — $name',
      async ({ worn, rest, stored, visual, motion }) => {
        const ctx = {
          ...sceneCtx,
          characterBible: [
            {
              ...aliceCharacter,
              standardClothing: worn.clothing,
              looks: [worn, ...rest],
            },
          ],
        };
        const legacyStyling = { c1: stored };
        // Whatever else moved since: this shape reads the voice-only flag
        // and the spec, as the current one does.
        for (const voiceOnlyMoved of [false, true]) {
          for (const acceptLegacy of [true, false]) {
            const opts = { voiceOnlyMoved, acceptLegacy, legacyStyling };
            expect(await visualPromptInputHashMatches(visual, ctx, opts)).toBe(
              true
            );
            expect(
              await motionPromptInputHashMatches(motion, ctx, {
                ...opts,
                legacyScriptDialogue: false,
              })
            ).toBe(true);
          }
        }
        // 4b: a stamp made now is the new shape, and verifies.
        const stamped = await hashVisualPromptInput(ctx);
        expect(stamped).not.toBe(visual);
        expect(
          await visualPromptInputHashMatches(stamped, ctx, {
            voiceOnlyMoved: false,
            legacyStyling,
          })
        ).toBe(true);
        // 4d: an unrelated bible edit stales the old stamp, as it did.
        const aged = {
          ...ctx,
          characterBible: ctx.characterBible.map((c) => ({ ...c, age: '31' })),
        };
        expect(
          await visualPromptInputHashMatches(visual, aged, {
            voiceOnlyMoved: false,
            legacyStyling,
          })
        ).toBe(false);
      }
    );

    it('4b: the default look’s styling edit moves the text, and the old stamp goes stale', async () => {
      const [first] = cases;
      if (!first) throw new Error('fixture');
      // The save wrote the submitted styling to the look and nulled the
      // bible's features: stored and effective are now the same text.
      const edited = office('hair down');
      const ctx = {
        ...sceneCtx,
        characterBible: [
          {
            ...aliceCharacter,
            standardClothing: 'coat',
            looks: [edited, gala],
          },
        ],
      };
      const legacyStyling = {
        c1: { distinguishingFeatures: null, styling: 'hair down' },
      };
      const opts = { voiceOnlyMoved: false, legacyStyling };
      expect(await visualPromptInputHashMatches(first.visual, ctx, opts)).toBe(
        false
      );
      expect(
        await motionPromptInputHashMatches(first.motion, ctx, {
          ...opts,
          legacyScriptDialogue: false,
        })
      ).toBe(false);
      expect(
        await visualPromptInputHashMatches(
          await hashVisualPromptInput(ctx),
          ctx,
          opts
        )
      ).toBe(true);
    });

    it('a verify with no stored parts for a character fails loudly, not as stale', async () => {
      await expect(
        visualPromptInputHashMatches('0'.repeat(64), sceneCtx, {
          voiceOnlyMoved: false,
          legacyStyling: {},
        })
      ).rejects.toThrow('no legacy styling parts for character c1');
    });
  });

  it('visual and motion prompt hashes are namespaced by artifact and differ', async () => {
    const visual = await hashVisualPromptInput(sceneCtx);
    const motion = await hashMotionPromptInput(sceneCtx);
    expect(visual).not.toBe(motion);
    expect(visual).toMatch(/^[0-9a-f]{64}$/);
    expect(motion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the current motion digest ignores the rendered still (#1923)', async () => {
    const baseline = await hashMotionPromptInput(sceneCtx);
    const withImage = await hashMotionPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/a.png',
    });
    const withReRenderedImage = await hashMotionPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/b.png',
    });
    expect(withImage).toBe(baseline);
    expect(withReRenderedImage).toBe(withImage);
    // A legacy stamp still carries the URL, so an old LLM prompt goes stale
    // once when its still changes.
    const v4 = await computeMotionPromptInputHashV4(sceneCtx, BLANK_LEGACY);
    const v4Image = await computeMotionPromptInputHashV4(
      {
        ...sceneCtx,
        startingFrameImageUrl: '/r2/frames/a.png',
      },
      BLANK_LEGACY
    );
    expect(v4Image).not.toBe(v4);
  });

  it('reference-only re-stales the motion prompt but never the visual one', async () => {
    const baseline = await hashMotionPromptInput(sceneCtx);
    const referenceOnly = await hashMotionPromptInput({
      ...sceneCtx,
      referenceOnly: true,
    });
    // The mode picks a different LLM template, so the prompt it produces for
    // the same scene is materially different.
    expect(referenceOnly).not.toBe(baseline);

    // The visual prompt produces the still; it cannot depend on whether one
    // gets rendered.
    expect(
      await hashVisualPromptInput({ ...sceneCtx, referenceOnly: true })
    ).toBe(await hashVisualPromptInput(sceneCtx));
  });

  it("the motion prompt hashes the shot's lines, not the script's; voices do not stale it (#1554, #1784)", async () => {
    // Voice identity binds on the clip (`audioSourceKey`), like a character
    // sheet on the still. The LLM never sees the ElevenLabs id or the bound
    // voice token, so neither may move the motion-prompt digest.
    const line = { character: 'Alice', line: 'Stay down.', tone: '' };
    const stayDown = { presence: true, lines: [line] };
    const withDialogue = { ...sceneCtx, dialogue: stayDown };
    expect(await hashMotionPromptInput(withDialogue)).not.toBe(
      await hashMotionPromptInput(sceneCtx)
    );
    // An edited line re-stales the prompt…
    expect(
      await hashMotionPromptInput({
        ...sceneCtx,
        dialogue: {
          presence: true,
          lines: [
            { character: 'Alice', line: 'Stay down.', tone: 'whispered' },
          ],
        },
      })
    ).not.toBe(await hashMotionPromptInput(withDialogue));
    // …a bound voice does not…
    expect(
      await hashMotionPromptInput({
        ...sceneCtx,
        dialogue: {
          presence: true,
          lines: [{ ...line, voiceToken: '@Audio1' }],
        },
      })
    ).toBe(await hashMotionPromptInput(withDialogue));
    // …and the script's own lines are not what the shot says.
    const scriptSaysOther = {
      ...minimalScene,
      originalScript: {
        extract: '',
        dialogue: [{ character: 'Alice', line: 'Run.', tone: '' }],
      },
    };
    expect(
      await hashMotionPromptInput({ ...withDialogue, scene: scriptSaysOther })
    ).toBe(await hashMotionPromptInput(withDialogue));
    // The visual prompt still reads the script.
    expect(
      await hashVisualPromptInput({ ...sceneCtx, scene: scriptSaysOther })
    ).not.toBe(await hashVisualPromptInput(sceneCtx));
  });

  it("keeps an unedited shot's stored motion digest (#1784)", async () => {
    // What `main` stamped before #1784, hashed over the SCRIPT's lines. A shot
    // whose node row holds the same lines still verifies that digest.
    const line = { character: 'Alice', line: 'Stay down.', tone: 'calm' };
    const ctx = {
      ...sceneCtx,
      scene: {
        ...minimalScene,
        originalScript: { extract: '', dialogue: [line] },
      },
      characterBible: [],
      locationBible: [],
      analysisModel: 'm',
      dialogue: { presence: true, lines: [line] },
    };
    const stored =
      '0821831a048411fcb78c904bcecad4befdfafbba0ced9b7a7090df87bacab534';
    // The current digest omits the still URL (#1923), so it is a new stamp.
    // The stored one still verifies while the spec version is unchanged.
    expect(await hashMotionPromptInput(ctx)).not.toBe(stored);
    expect(
      await motionPromptInputHashMatches(stored, ctx, {
        legacyScriptDialogue: false,
        ...VOICE_STILL,
        acceptLegacy: true,
      })
    ).toBe(true);
  });

  it('the pipeline stamp matches the verify of the row scene-split seeds (#1784)', async () => {
    const lines = [
      { character: 'Alice', line: 'Run.', tone: 'urgent', shotNumber: 1 },
      { character: 'Bob', line: 'Where?', tone: '', shotNumber: 2 },
    ];
    const scene = {
      ...minimalScene,
      originalScript: { extract: '', dialogue: lines },
    };
    const base = { ...sceneCtx, characterBible: [], locationBible: [] };
    // The batch: the scene narrowed to shot 2, its lines as the dialogue.
    const narrowed = sceneForShot(scene, 2);
    const stamped = await hashMotionPromptInput({
      ...base,
      scene: narrowed,
      dialogue: shotDialogue(narrowed.originalScript.dialogue),
    });
    // Verify: the resolver reads the row scene-split seeded for shot 2.
    const seeded = deriveShotDialogueLines(lines, { shotNumber: 2 }, false);
    const verified = await hashMotionPromptInput({
      ...base,
      scene: narrowed,
      dialogue: shotDialogue(seeded),
    });
    expect(verified).toBe(stamped);
  });

  it('accepts a script-shaped digest only for a shot with no node row (#1784)', async () => {
    const script = {
      ...minimalScene,
      originalScript: {
        extract: '',
        dialogue: [{ character: 'Alice', line: 'Stay down.', tone: '' }],
      },
    };
    // Stamped before #1784: the script's lines were the shot's lines.
    const stamped = await hashMotionPromptInput({
      ...sceneCtx,
      scene: script,
      dialogue: {
        presence: true,
        lines: script.originalScript.dialogue,
      },
    });
    // Now the shot says something else.
    const now = {
      ...sceneCtx,
      scene: script,
      dialogue: {
        presence: true,
        lines: [{ character: 'Alice', line: 'Stay up.', tone: '' }],
      },
    };
    // No node row: the difference is the resolver's reading of old data
    // (unstamped lines, a pre-#1657 prompt row), not an edit. Still fresh.
    expect(
      await motionPromptInputHashMatches(stamped, now, {
        legacyScriptDialogue: true,
        ...VOICE_STILL,
      })
    ).toBe(true);
    // A node row: that is an edit, and it re-stales the prompt.
    expect(await motionPromptInputHashMatches(stamped, now, NODE)).toBe(false);
  });

  it('assembler rejects a missing referenceOnly channel (#1616)', () => {
    const { referenceOnly: _dropped, ...withoutFlag } = sceneCtx;
    expect(() => assembleMotionPromptHashInput(withoutFlag)).toThrow();
    expect(assembleMotionPromptHashInput(sceneCtx).referenceOnly).toBe(false);
  });

  it('branded digest is not a raw sha256 of {kind, text} (#1616)', async () => {
    const derived = await sha256Hex({
      kind: 'derived-shot-motion',
      shotId: 's1',
      text: 'move',
    });
    const assembler = await hashMotionPromptInput(sceneCtx);
    expect(assembler).not.toBe(derived);
    expectTypeOf(assembler).toEqualTypeOf<MotionPromptInputHash>();
    expectTypeOf<string>().not.toMatchTypeOf<MotionPromptInputHash>();
    expectTypeOf<
      Omit<MotionPromptHashInput, 'referenceOnly'>
    >().not.toMatchTypeOf<MotionPromptHashInput>();
  });

  it('leaves every stored image-to-video digest unchanged', async () => {
    // The flag joins the hash body only when true, so no existing row's
    // digest moves and no hash-version bump is needed.
    const omitted = await hashMotionPromptInput(sceneCtx);
    const explicitFalse = await hashMotionPromptInput({
      ...sceneCtx,
      referenceOnly: false,
    });
    expect(explicitFalse).toBe(omitted);
    expect(await motionPromptInputHashMatches(omitted, sceneCtx, NODE)).toBe(
      true
    );
  });

  it('personality / movement re-stale the motion prompt only, and only when set (#1561)', async () => {
    const withPerformance = {
      ...sceneCtx,
      characterBible: [
        { ...aliceCharacter, personality: 'guarded', movement: 'limps' },
      ],
    };
    // Motion reads them: gait and delivery change the prompt.
    expect(await hashMotionPromptInput(withPerformance)).not.toBe(
      await hashMotionPromptInput(sceneCtx)
    );
    // A still does not walk: the visual prompt ignores both.
    expect(await hashVisualPromptInput(withPerformance)).toBe(
      await hashVisualPromptInput(sceneCtx)
    );
    // Shape-stable: a character with neither hashes exactly as before the
    // fields existed, so no stored motion digest moves.
    const whitespace = {
      ...sceneCtx,
      characterBible: [{ ...aliceCharacter, personality: '  ', movement: '' }],
    };
    expect(await hashMotionPromptInput(whitespace)).toBe(
      await hashMotionPromptInput(sceneCtx)
    );
    // Pre-#1561 JSON (checkpoints, sheet metadata) has no keys at all.
    const { personality: _p, movement: _m, ...legacyAlice } = aliceCharacter;
    const legacy = {
      ...sceneCtx,
      // stored JSON that predates the fields
      characterBible: [asStub<CharacterBibleEntry>(legacyAlice)],
    };
    expect(await hashMotionPromptInput(legacy)).toBe(
      await hashMotionPromptInput(sceneCtx)
    );
  });

  it('omitting startingFrameImageUrl equals passing null (legacy shots)', async () => {
    const omitted = await hashMotionPromptInput(sceneCtx);
    const explicitNull = await hashMotionPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: null,
    });
    expect(omitted).toBe(explicitNull);
  });

  it('spec content moves the current prompt digest; a pre-spec stamp still matches (#1923)', async () => {
    const spec = {
      framing: {
        shotSize: 'wide',
        angle: 'eye',
        composition: 'center',
        subjectStartState: 'still',
      },
      action: 'walks',
      cameraMovement: { move: 'dolly in, then pan left', pacing: 'slow' },
      direction: '',
      soundCue: '',
    };
    const without = await hashVisualPromptInput(sceneCtx);
    const withSpec = await hashVisualPromptInput({ ...sceneCtx, spec });
    const reordered = await hashVisualPromptInput({
      ...sceneCtx,
      spec: {
        soundCue: spec.soundCue,
        direction: spec.direction,
        action: spec.action,
        cameraMovement: {
          pacing: spec.cameraMovement.pacing,
          move: spec.cameraMovement.move,
        },
        framing: {
          subjectStartState: spec.framing.subjectStartState,
          composition: spec.framing.composition,
          angle: spec.framing.angle,
          shotSize: spec.framing.shotSize,
        },
      },
    });
    expect(withSpec).not.toBe(without);
    expect(reordered).toBe(withSpec);
    // A stamp from before specs: the newest shape that has none.
    const preSpec = await computeVisualPromptInputHashV4(
      sceneCtx,
      BLANK_LEGACY,
      'v5-voiced'
    );
    expect(
      await visualPromptInputHashMatches(
        preSpec,
        { ...sceneCtx, spec },
        {
          ...VOICE_STILL,
          acceptLegacy: true,
        }
      )
    ).toBe(true);
    expect(
      await visualPromptInputHashMatches(
        preSpec,
        { ...sceneCtx, spec },
        {
          ...VOICE_STILL,
          acceptLegacy: false,
        }
      )
    ).toBe(false);
    const changed = {
      ...spec,
      cameraMovement: { ...spec.cameraMovement, move: 'static' },
    };
    expect(
      await hashMotionPromptInput({ ...sceneCtx, spec: changed })
    ).not.toBe(await hashMotionPromptInput({ ...sceneCtx, spec }));
  });

  it('the visual prompt hash ignores the starting frame (it produces the image)', async () => {
    const baseline = await hashVisualPromptInput(sceneCtx);
    const withImage = await hashVisualPromptInput({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/a.png',
    });
    expect(withImage).toBe(baseline);
  });

  it('bible array order does not affect the visual prompt hash', async () => {
    const second: CharacterBibleEntry = {
      ...aliceCharacter,
      characterId: 'c2',
      name: 'Bob',
    };
    const orderA = await hashVisualPromptInput({
      ...sceneCtx,
      characterBible: [aliceCharacter, second],
    });
    const orderB = await hashVisualPromptInput({
      ...sceneCtx,
      characterBible: [second, aliceCharacter],
    });
    expect(orderA).toBe(orderB);
  });

  // canonicalize() treats a repeated object reference as a cycle, so each
  // clone needs its own nested firstMention object.
  const cloneLocation = (
    overrides: Partial<LocationBibleEntry>
  ): LocationBibleEntry => ({
    ...beachLocation,
    ...overrides,
    firstMention: { sceneId: '', text: '', lineNumber: 0 },
  });

  it('locationBible order does not affect the visual prompt hash', async () => {
    const first = cloneLocation({});
    const second = cloneLocation({ locationId: 'l2', name: 'Forest' });
    const orderA = await hashVisualPromptInput({
      ...sceneCtx,
      locationBible: [first, second],
    });
    const orderB = await hashVisualPromptInput({
      ...sceneCtx,
      locationBible: [second, first],
    });
    expect(orderA).toBe(orderB);
  });

  it('elementBible order does not affect the visual prompt hash', async () => {
    const elementA = {
      token: 'LOGO',
      description: 'Red hex logo',
      consistencyTag: 'red-hex-logo',
      firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
    };
    const elementB = {
      token: 'BADGE',
      description: 'Police badge',
      consistencyTag: 'police-badge',
      firstMention: { sceneId: 's1', text: 'BADGE', lineNumber: 2 },
    };
    const orderA = await hashVisualPromptInput({
      ...sceneCtx,
      elementBible: [elementA, elementB],
    });
    const orderB = await hashVisualPromptInput({
      ...sceneCtx,
      elementBible: [elementB, elementA],
    });
    expect(orderA).toBe(orderB);
  });

  it('bible array order does not affect the motion prompt hash (all three bibles)', async () => {
    const characterA: CharacterBibleEntry = { ...aliceCharacter };
    const characterB: CharacterBibleEntry = {
      ...aliceCharacter,
      characterId: 'c2',
      name: 'Bob',
    };
    const locationA = cloneLocation({});
    const locationB = cloneLocation({ locationId: 'l2', name: 'Forest' });
    const elementA = {
      token: 'LOGO',
      description: 'Red hex logo',
      consistencyTag: 'red-hex-logo',
      firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
    };
    const elementB = {
      token: 'BADGE',
      description: 'Police badge',
      consistencyTag: 'police-badge',
      firstMention: { sceneId: 's1', text: 'BADGE', lineNumber: 2 },
    };
    const orderA = await hashMotionPromptInput({
      ...sceneCtx,
      characterBible: [characterA, characterB],
      locationBible: [locationA, locationB],
      elementBible: [elementA, elementB],
    });
    const orderB = await hashMotionPromptInput({
      ...sceneCtx,
      characterBible: [characterB, characterA],
      locationBible: [locationB, locationA],
      elementBible: [elementB, elementA],
    });
    expect(orderA).toBe(orderB);
  });

  it('a scene-title rename does not change the visual prompt stamp', async () => {
    const metadata = {
      title: 'Opening',
      durationSeconds: 5,
      location: 'INT. STUDIO',
      timeOfDay: 'night',
      storyBeat: 'establish',
    };
    const a = await hashVisualPromptInput({
      ...sceneCtx,
      scene: { ...minimalScene, metadata },
    });
    const b = await hashVisualPromptInput({
      ...sceneCtx,
      scene: { ...minimalScene, metadata: { ...metadata, title: 'Renamed' } },
    });
    expect(a).toBe(b);
  });

  it('dual-hash verify accepts a v4 visual digest of the same inputs', async () => {
    expect(LEGACY_HASH_UNTIL).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const current = await hashVisualPromptInput(sceneCtx);
    const v4 = await computeVisualPromptInputHashV4(sceneCtx, BLANK_LEGACY);
    expect(v4).not.toBe(current);
    expect(
      await visualPromptInputHashMatches(current, sceneCtx, VOICE_STILL)
    ).toBe(true);
    expect(await visualPromptInputHashMatches(v4, sceneCtx, VOICE_STILL)).toBe(
      true
    );
    expect(
      await visualPromptInputHashMatches(
        v4,
        {
          ...sceneCtx,
          analysisModel: 'anthropic/claude-sonnet-4.6',
        },
        VOICE_STILL
      )
    ).toBe(false);
  });

  it('dual-hash verify accepts a v4 motion digest of the same inputs', async () => {
    const current = await hashMotionPromptInput(sceneCtx);
    const v4 = await computeMotionPromptInputHashV4(sceneCtx, BLANK_LEGACY);
    expect(v4).not.toBe(current);
    expect(await motionPromptInputHashMatches(current, sceneCtx, NODE)).toBe(
      true
    );
    expect(await motionPromptInputHashMatches(v4, sceneCtx, NODE)).toBe(true);
    expect(
      await motionPromptInputHashMatches(
        v4,
        {
          ...sceneCtx,
          analysisModel: 'anthropic/claude-sonnet-4.6',
        },
        NODE
      )
    ).toBe(false);
  });

  it('changing the analysis model changes the visual prompt hash', async () => {
    const a = await hashVisualPromptInput(sceneCtx);
    const b = await hashVisualPromptInput({
      ...sceneCtx,
      analysisModel: 'anthropic/claude-sonnet-4.6',
    });
    expect(a).not.toBe(b);
  });

  it('elementBible changes flow through to both visual and motion prompt hashes', async () => {
    const withoutElements = sceneCtx;
    const withElement = {
      ...sceneCtx,
      elementBible: [
        {
          token: 'LOGO',
          description: 'Red hex logo',
          consistencyTag: 'red-hex-logo',
          firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
        },
      ],
    };

    const visualA = await hashVisualPromptInput(withoutElements);
    const visualB = await hashVisualPromptInput(withElement);
    const motionA = await hashMotionPromptInput(withoutElements);
    const motionB = await hashMotionPromptInput(withElement);

    expect(visualA).not.toBe(visualB);
    expect(motionA).not.toBe(motionB);
  });

  const baseSummary: MusicSceneSummary = {
    sceneId: 's1',
    title: 'Opening',
    storyBeat: 'Establish tone',
    durationSeconds: 10,
    location: 'INT. STUDIO - NIGHT',
    timeOfDay: 'night',
  };

  it('music prompt hash is stable for equivalent inputs and changes with sceneSummaries', async () => {
    const a = await computeMusicPromptInputHash({
      sceneSummaries: [baseSummary],
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary }],
      analysisModel: 'm',
    });
    const c = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary, storyBeat: 'Twist reveal' }],
      analysisModel: 'm',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('a scene-title rename does not change the music prompt stamp', async () => {
    const a = await computeMusicPromptInputHash({
      sceneSummaries: [baseSummary],
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary, title: 'Renamed opening' }],
      analysisModel: 'm',
    });
    expect(a).toBe(b);
  });

  it('the scene id is not part of the music prompt stamp (#1783)', async () => {
    const a = await computeMusicPromptInputHash({
      sceneSummaries: [baseSummary],
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary, sceneId: 'row-id' }],
      analysisModel: 'm',
    });
    expect(a).toBe(b);
  });

  it('scene lighting and palette overrides change both prompt hashes', async () => {
    // These fields are now editable scene inputs (#1889), not LLM output.
    const upstream = await hashVisualPromptInput(sceneCtx);
    const enriched = await hashVisualPromptInput({
      ...sceneCtx,
      scene: {
        ...minimalScene,
        continuity: {
          characterTags: ['alice'],
          environmentTag: 'beach',
          colorPalette: 'warm',
          lightingSetup: 'golden hour',
          styleTag: 'cinematic',
        },
      },
    });
    expect(upstream).not.toBe(enriched);

    const motionUpstream = await hashMotionPromptInput(sceneCtx);
    const motionEnriched = await hashMotionPromptInput({
      ...sceneCtx,
      scene: {
        ...minimalScene,
        continuity: {
          characterTags: ['alice'],
          environmentTag: 'beach',
          colorPalette: 'warm',
          lightingSetup: 'golden hour',
          styleTag: 'cinematic',
        },
      },
    });
    expect(motionUpstream).not.toBe(motionEnriched);
  });
});

describe('computeSequenceMusicInputHash', () => {
  const base = {
    prompt: 'Cinematic orchestral build',
    tags: 'cinematic,tension,strings',
    durationSeconds: 60,
    audioModel: 'cassette-v1',
  };

  it('is stable for identical input', async () => {
    const a = await computeSequenceMusicInputHash(base);
    const b = await computeSequenceMusicInputHash({ ...base });
    expect(a).toBe(b);
  });

  it('reacts to prompt, tags, duration, and model', async () => {
    const a = await computeSequenceMusicInputHash(base);
    const prompt = await computeSequenceMusicInputHash({
      ...base,
      prompt: 'Soft piano',
    });
    const tags = await computeSequenceMusicInputHash({
      ...base,
      tags: 'piano,calm',
    });
    const duration = await computeSequenceMusicInputHash({
      ...base,
      durationSeconds: 90,
    });
    const model = await computeSequenceMusicInputHash({
      ...base,
      audioModel: 'cassette-v2',
    });
    expect(new Set([a, prompt, tags, duration, model]).size).toBe(5);
  });

  it('trims leading/trailing whitespace on prompt and tags', async () => {
    const trimmed = await computeSequenceMusicInputHash(base);
    const padded = await computeSequenceMusicInputHash({
      ...base,
      prompt: '  Cinematic orchestral build  ',
      tags: '\tcinematic,tension,strings\n',
    });
    expect(padded).toBe(trimmed);
  });
});

describe('voiceOnlyMovedSince (#1787)', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const v = (characterId: string, voiceOnly: boolean, minutes: number) => ({
    characterId,
    voiceOnly,
    createdAt: new Date(at.getTime() + minutes * 60_000),
  });

  it('a flip after the stamp moved; a first version or an earlier flip did not', () => {
    expect(voiceOnlyMovedSince([v('a', false, -2), v('a', true, 1)], at)).toBe(
      true
    );
    expect(voiceOnlyMovedSince([v('a', true, 1)], at)).toBe(false);
    expect(voiceOnlyMovedSince([v('a', false, -2), v('a', true, -1)], at)).toBe(
      false
    );
    // Another character's first version is not a flip of this one.
    expect(voiceOnlyMovedSince([v('a', false, -2), v('b', true, 1)], at)).toBe(
      false
    );
  });
});
