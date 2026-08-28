import { describe, expect, test } from 'vitest';
import { migrateStyleConfigV1ToV2 } from '@/lib/style/style-config';
import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { StyleConfig } from '@/lib/db/schema';
import {
  buildCastCharacterBible,
  buildCastingAttributes,
  buildCharacterSheetPrompt,
} from './character-prompt';

const scriptEntry: CharacterBibleEntry = {
  characterId: 'char_001',
  name: 'Detective Sarah',
  age: '30s',
  gender: 'Female',
  ethnicity: 'Caucasian',
  physicalDescription: 'Tall, blonde hair, blue eyes',
  standardClothing: 'Dark trench coat, badge on belt',
  distinguishingFeatures: 'Small scar on left cheek',
  consistencyTag: 'detective_sarah_blonde_30s',
};

const talentMetadata: CharacterBibleEntry = {
  characterId: 'talent_sheet_1',
  name: 'Elvis Presley',
  age: '25',
  gender: 'Male',
  ethnicity: 'White',
  physicalDescription: 'Dark hair, sideburns, athletic build',
  standardClothing: 'White jumpsuit',
  distinguishingFeatures: 'Signature sideburns',
  consistencyTag: 'elvis_presley',
};

describe('buildCastingAttributes', () => {
  test('uses talent physical attributes over script', () => {
    const result = buildCastingAttributes(scriptEntry, {
      sheetMetadata: talentMetadata,
      talentName: 'Elvis Presley',
    });

    expect(result.age).toBe('25');
    expect(result.gender).toBe('Male');
    expect(result.ethnicity).toBe('White');
    expect(result.physicalDescription).toBe(
      'Dark hair, sideburns, athletic build'
    );
  });

  test('keeps costume and distinguishing features from script', () => {
    const result = buildCastingAttributes(scriptEntry, {
      sheetMetadata: talentMetadata,
      talentName: 'Elvis Presley',
    });

    expect(result.standardClothing).toBe('Dark trench coat, badge on belt');
    expect(result.distinguishingFeatures).toBe('Small scar on left cheek');
  });

  test('generates consistencyTag from characterId + talent name', () => {
    const result = buildCastingAttributes(scriptEntry, {
      sheetMetadata: talentMetadata,
      talentName: 'Elvis Presley',
    });

    expect(result.consistencyTag).toBe('char_001_elvis_presley');
  });

  test('falls back to script attributes when talent metadata is missing', () => {
    const result = buildCastingAttributes(scriptEntry, {
      talentName: 'Elvis Presley',
    });

    expect(result.age).toBe('30s');
    expect(result.gender).toBe('Female');
    expect(result.ethnicity).toBe('Caucasian');
  });

  test('anchors physicalDescription to the reference image (never the talent name) when talent metadata has no physicalDescription', () => {
    const sparseMetadata: CharacterBibleEntry = {
      ...talentMetadata,
      physicalDescription: '',
    };

    const result = buildCastingAttributes(scriptEntry, {
      sheetMetadata: sparseMetadata,
      talentName: 'Elvis Presley',
    });

    // Naming a person + "match exactly" trips OpenAI's likeness moderation —
    // the fallback must reference the image, not the talent's name.
    expect(result.physicalDescription).not.toContain('Elvis Presley');
    expect(result.physicalDescription).toContain('reference image');
  });

  test('consistencyTag is deterministic', () => {
    const result1 = buildCastingAttributes(scriptEntry, {
      sheetMetadata: talentMetadata,
      talentName: 'Elvis Presley',
    });
    const result2 = buildCastingAttributes(scriptEntry, {
      sheetMetadata: talentMetadata,
      talentName: 'Elvis Presley',
    });

    expect(result1.consistencyTag).toBe(result2.consistencyTag);
  });

  test('uses sparse talent fields over script when available', () => {
    const partialMeta: CharacterBibleEntry = {
      ...talentMetadata,
      age: '40',
      gender: '',
      ethnicity: '',
      physicalDescription: 'Muscular build',
    };

    const result = buildCastingAttributes(scriptEntry, {
      sheetMetadata: partialMeta,
      talentName: 'Test Actor',
    });

    expect(result.age).toBe('40');
    expect(result.gender).toBe('Female'); // falls back to script
    expect(result.ethnicity).toBe('Caucasian'); // falls back to script
    expect(result.physicalDescription).toBe('Muscular build');
  });
});

describe('buildCastCharacterBible', () => {
  const bob: CharacterBibleEntry = {
    characterId: 'char_002',
    name: 'Bob',
    age: '40',
    gender: 'Male',
    ethnicity: 'Asian',
    physicalDescription: 'Short, dark hair',
    standardClothing: 'Grey suit',
    distinguishingFeatures: 'Glasses',
    consistencyTag: 'bob_grey_suit',
  };

  test('applies casting to a matched character', () => {
    const [cast] = buildCastCharacterBible(
      [scriptEntry],
      [
        {
          characterId: 'char_001',
          talentName: 'Elvis Presley',
          sheetMetadata: talentMetadata,
        },
      ]
    );
    if (!cast) throw new Error('expected one cast entry');

    // Matches buildCastingAttributes exactly (the same transform the
    // character-bible workflow persists) — this is what makes the prompt hash
    // equal the verify-time recompute.
    const expected = buildCastingAttributes(scriptEntry, {
      sheetMetadata: talentMetadata,
      talentName: 'Elvis Presley',
    });
    expect(cast).toEqual({
      characterId: 'char_001',
      name: 'Detective Sarah',
      ...expected,
    });
    expect(cast.physicalDescription).toBe(
      'Dark hair, sideburns, athletic build'
    );
    expect(cast.consistencyTag).toBe('char_001_elvis_presley');
  });

  test('leaves an unmatched character untouched (identity)', () => {
    const input: CharacterBibleEntry[] = [scriptEntry, bob];
    const result = buildCastCharacterBible(input, [
      {
        characterId: 'char_001',
        talentName: 'Elvis Presley',
        sheetMetadata: talentMetadata,
      },
    ]);
    // bob has no match → returned by reference, unchanged.
    expect(result[1]).toBe(bob);
  });

  test('no matches → returns every entry unchanged', () => {
    const input: CharacterBibleEntry[] = [scriptEntry, bob];
    const result = buildCastCharacterBible(input, []);
    expect(result).toEqual(input);
  });

  test('preserves characterId and name when casting', () => {
    const [cast] = buildCastCharacterBible(
      [scriptEntry],
      [{ characterId: 'char_001', talentName: 'Elvis Presley' }]
    );
    if (!cast) throw new Error('expected one cast entry');
    expect(cast.characterId).toBe('char_001');
    expect(cast.name).toBe('Detective Sarah');
  });
});

const neoNoirStyle: StyleConfig = migrateStyleConfigV1ToV2({
  mood: 'Dark, brooding, and atmospheric',
  artStyle:
    'Neo-noir cinematic style with deep shadows and high contrast. Gritty urban realism with expressionist framing.',
  lighting:
    'Low-key chiaroscuro lighting with single hard sources. Venetian blind shadows, neon reflections, harsh rim lighting.',
  colorPalette: ['#0A0A0A', '#1A1A2E', '#E94560', '#16213E', '#533483'],
  cameraWork:
    'Dutch angles, low-angle power shots, tight close-ups. Slow deliberate movements with dramatic reveals.',
  referenceFilms: [
    'rain-slicked neon-noir cityscape cinematography',
    'high-contrast graphic-novel monochrome',
    'synthwave night-drive thriller framing',
  ],
  colorGrading:
    'Desaturated with selective color pops. Teal and orange split toning with crushed blacks.',
});

describe('buildCharacterSheetPrompt with styleConfig', () => {
  test('without styleConfig produces default studio prompt', () => {
    const { prompt } = buildCharacterSheetPrompt(scriptEntry);

    expect(prompt).toContain('cyclorama');
    expect(prompt).toContain('5500K daylight');
    expect(prompt).toContain('Commercial reference photography');
  });

  test('with styleConfig replaces environment, lighting, and optical sections', () => {
    const { prompt } = buildCharacterSheetPrompt(
      scriptEntry,
      undefined,
      neoNoirStyle
    );

    // Should NOT contain studio defaults
    expect(prompt).not.toContain('cyclorama');
    expect(prompt).not.toContain('5500K daylight');
    expect(prompt).not.toContain('Commercial reference photography');

    // Should contain style-derived content
    expect(prompt).toContain('Neo-noir cinematic style');
    expect(prompt).toContain('chiaroscuro');
    expect(prompt).toContain('Dark, brooding');
    expect(prompt).toContain('rain-slicked neon-noir cityscape');
  });

  test('with styleConfig preserves layout and materiality sections', () => {
    const { prompt } = buildCharacterSheetPrompt(
      scriptEntry,
      undefined,
      neoNoirStyle
    );

    expect(prompt).toContain('[LAYOUT]');
    expect(prompt).toContain('four distinct, technical views');
    expect(prompt).toContain('[MATERIALITY]');
    expect(prompt).toContain('Hyper-accurate rendering');
  });

  test('with styleConfig and talentOverrides composes correctly', () => {
    const { prompt, referenceUrls } = buildCharacterSheetPrompt(
      scriptEntry,
      {
        sheetMetadata: talentMetadata,
        sheetImageUrl: 'https://example.com/sheet.png',
      },
      neoNoirStyle
    );

    // Style is applied
    expect(prompt).toContain('Neo-noir cinematic style');
    expect(prompt).not.toContain('cyclorama');

    // Talent reference is preserved
    expect(prompt).toContain('IMAGE takes priority');
    expect(referenceUrls).toContain('https://example.com/sheet.png');

    // Talent appearance is used
    expect(prompt).toContain('Male');
    expect(prompt).toContain('Dark hair, sideburns');
  });
});

describe('buildCharacterSheetPrompt with talent', () => {
  test('uses talent description as fallback when physicalDescription is empty', () => {
    const { prompt } = buildCharacterSheetPrompt(scriptEntry, {
      description: 'This character should look like Elvis Presley',
    });

    expect(prompt).toContain('Elvis Presley');
    expect(prompt).toContain('reference image');
  });

  test('strengthened reference instruction mentions image priority', () => {
    const { prompt } = buildCharacterSheetPrompt(scriptEntry, {
      sheetMetadata: talentMetadata,
      sheetImageUrl: 'https://example.com/sheet.png',
    });

    expect(prompt).toContain('IMAGE takes priority');
    expect(prompt).toContain('DO NOT alter their fundamental physical');
  });
});
