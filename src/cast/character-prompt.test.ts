import { describe, expect, test } from 'vitest';
import type { CharacterBibleEntry } from '@/shots/scene-analysis.schema';
import type { CharacterMinimal } from '@/platform/server/db/schema';
import {
  buildCharacterReferenceImages,
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
  looks: [],
  personality: '',
  movement: '',
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
  rendering: 'Photoreal live action',
  consistencyTag: 'detective_sarah_blonde_30s',
};

describe('buildCharacterReferenceImages', () => {
  const sheet = (
    overrides: Partial<CharacterMinimal> & { name: string }
  ): CharacterMinimal => ({
    id: `id_${overrides.name}`,
    characterId: overrides.name.toLowerCase(),
    sheetImageUrl: `/r2/${overrides.name}.png`,
    sheetStatus: 'completed',
    sheetInputHash: 'hash',
    selectedSheetVersionId: null,
    // Wearing its default look (#2015).
    lookId: 'default-look',
    lookName: 'Default',
    looks: [],
    physicalDescription: `${overrides.name} is here`,
    voiceOnly: false,
    isPerson: true,
    consistencyTag: overrides.name.toLowerCase(),
    ...overrides,
  });

  test('copies isPerson onto the motion reference (#1682)', () => {
    expect(
      buildCharacterReferenceImages([
        sheet({ name: 'Sarah', isPerson: true }),
        sheet({ name: 'UNIT-7', isPerson: false }),
      ])
    ).toEqual([
      expect.objectContaining({
        token: 'Sarah',
        isPerson: true,
      }),
      expect.objectContaining({
        token: 'UNIT-7',
        isPerson: false,
      }),
    ]);
  });

  test('a missing isPerson on an in-flight checkpoint still registers', () => {
    const legacy = sheet({ name: 'Ada', isPerson: true });
    // oxlint-disable-next-line typescript/no-dynamic-delete -- drop the flag the way a pre-#1682 checkpoint would
    delete (legacy as { isPerson?: boolean }).isPerson;
    expect(buildCharacterReferenceImages([legacy])).toEqual([
      expect.objectContaining({ token: 'Ada' }),
    ]);
    expect(
      buildCharacterReferenceImages([legacy])[0]?.isPerson
    ).toBeUndefined();
  });
});

describe('buildCharacterSheetPrompt rendering (#2017)', () => {
  test('photoreal keeps the commercial reference photography studio', () => {
    const { prompt } = buildCharacterSheetPrompt(scriptEntry, null, null);
    expect(prompt).toContain('cyclorama');
    expect(prompt).toContain('5500K daylight');
    expect(prompt).toContain('Commercial reference photography');
  });

  test('another rendering names it in the environment and optics, on the same neutral studio', () => {
    const { prompt } = buildCharacterSheetPrompt(
      { ...scriptEntry, rendering: '3D animated, Pixar-like' },
      null,
      null
    );
    expect(prompt).toContain(
      'Render the character as 3D animated, Pixar-like.'
    );
    expect(prompt).toContain('3D animated, Pixar-like rendering.');
    expect(prompt).not.toContain('Commercial reference photography');
    expect(prompt).toContain('flat neutral white background');
    expect(prompt).toContain('5500K daylight');
  });

  test('the rendering keeps the layout and materiality sections', () => {
    const { prompt } = buildCharacterSheetPrompt(
      { ...scriptEntry, rendering: '2D cel animation' },
      null,
      null
    );
    expect(prompt).toContain('[LAYOUT]');
    expect(prompt).toContain('four distinct, technical views');
    expect(prompt).toContain('[MATERIALITY]');
    expect(prompt).toContain('Hyper-accurate rendering');
  });

  test('a rendering composes with the character bible', () => {
    const { prompt, referenceUrls } = buildCharacterSheetPrompt(
      { ...scriptEntry, rendering: '3D animated, Pixar-like' },
      null,
      null
    );
    expect(prompt).toContain(
      'Render the character as 3D animated, Pixar-like.'
    );
    expect(referenceUrls).toEqual([]);
    expect(prompt).toContain('Female');
    expect(prompt).toContain('Tall, blonde hair, blue eyes');
    expect(prompt).not.toContain('IMAGE takes priority');
  });
});

describe('buildCharacterSheetPrompt', () => {
  test("a look's styling notes join the costume as ONE section; none leaves the prompt as it was (#2015, #2065)", () => {
    const plain = buildCharacterSheetPrompt(scriptEntry, null, null).prompt;
    expect(plain).not.toContain('for this look');
    expect(buildCharacterSheetPrompt(scriptEntry, '  ', null).prompt).toBe(
      plain
    );

    const styled = buildCharacterSheetPrompt(
      scriptEntry,
      'hair pinned up, split lip',
      null
    ).prompt;
    expect(styled).toContain(
      'Costume:\nDark trench coat, badge on belt\n\nDistinguishing Features:\nhair pinned up, split lip'
    );
    expect(styled).not.toContain('for this look:');
    const other = buildCharacterSheetPrompt(
      scriptEntry,
      'hair pinned up, split lip',
      'https://e/default.png'
    ).prompt;
    expect(other).toContain(
      'Hair, Makeup & Condition for this look:\nhair pinned up, split lip'
    );
    expect(other).not.toContain('Distinguishing Features:\n');
  });

  test('a look drawn from the default sheet uses that image and no other', () => {
    const { prompt, referenceUrls } = buildCharacterSheetPrompt(
      scriptEntry,
      'hair pinned up',
      'https://example.com/default-look.png'
    );

    expect(referenceUrls).toEqual(['https://example.com/default-look.png']);
    expect(prompt).toContain("this character's default look");
    expect(prompt).toContain('Change the costume');
    expect(prompt).toContain('hair pinned up');
    expect(prompt).toContain('Tall, blonde hair, blue eyes');
  });

  test('the image wins for the person, the text wins for the outfit', () => {
    const { prompt } = buildCharacterSheetPrompt(
      scriptEntry,
      null,
      'https://example.com/default-look.png'
    );
    expect(prompt).toContain(
      'For face, body, skin and hair, the IMAGE takes priority over any text.'
    );
    expect(prompt).toContain(
      'For the clothing, the TEXT takes priority over the image: the reference wears another outfit.'
    );
    expect(prompt).not.toContain(
      'If any text conflicts with the reference image, the IMAGE takes priority.'
    );
  });
});
