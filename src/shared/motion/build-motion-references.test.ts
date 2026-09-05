import { describe, expect, it } from 'vitest';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import {
  buildMotionReferenceImages,
  buildShotImageReferenceImages,
} from './build-motion-references';

const character = (
  name: string,
  sheetImageUrl: string | null
): CharacterMinimal => ({
  id: `char-${name}`,
  characterId: name.toLowerCase(),
  name,
  sheetImageUrl,
  sheetStatus: 'completed',
  sheetInputHash: 'hash',
  selectedSheetVersionId: null,
  physicalDescription: `${name} is tall`,
  consistencyTag: name.toLowerCase(),
});

const element = (token: string, imageUrl: string): SequenceElementMinimal => ({
  id: `el-${token}`,
  token,
  description: `${token} description`,
  imageUrl,
  consistencyTag: token.toLowerCase(),
});

describe('buildMotionReferenceImages', () => {
  it('returns refs only for characters/elements the scene references', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene: {
        continuity: { characterTags: ['Alice'], elementTags: ['LOGO'] },
        originalScript: { extract: '' },
      },
      characters: [
        character('Alice', 'https://example.com/alice.png'),
        character('Bob', 'https://example.com/bob.png'),
      ],
      elements: [
        element('LOGO', 'https://example.com/logo.png'),
        element('PHONE', 'https://example.com/phone.png'),
      ],
    });

    expect(refs).toEqual([
      {
        referenceImageUrl: 'https://example.com/alice.png',
        description: 'Alice - Alice is tall',
        role: 'character',
        token: 'Alice',
      },
      {
        referenceImageUrl: 'https://example.com/logo.png',
        description: 'LOGO - LOGO description',
        role: 'element',
        token: 'LOGO',
      },
    ]);
  });

  it('matches elements named in the script even without an explicit tag', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene: {
        continuity: { characterTags: [], elementTags: [] },
        originalScript: { extract: 'She holds the PHONE up high.' },
      },
      characters: [],
      elements: [element('PHONE', 'https://example.com/phone.png')],
    });
    expect(refs.map((r) => r.referenceImageUrl)).toEqual([
      'https://example.com/phone.png',
    ]);
  });

  it('skips characters/elements with no reference image', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene: {
        continuity: { characterTags: ['Alice'], elementTags: ['LOGO'] },
        originalScript: { extract: '' },
      },
      characters: [character('Alice', null)],
      elements: [element('LOGO', '')],
    });
    expect(refs).toEqual([]);
  });

  it('returns nothing for a scene with no continuity', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene: null,
      characters: [character('Alice', 'https://example.com/alice.png')],
      elements: [element('LOGO', 'https://example.com/logo.png')],
    });
    expect(refs).toEqual([]);
  });
});

describe('buildShotImageReferenceImages', () => {
  it('attaches a character named in the visual prompt even with empty tags (#1432)', () => {
    const refs = buildShotImageReferenceImages({
      scene: {
        continuity: { characterTags: [], elementTags: [], environmentTag: '' },
        originalScript: { extract: '' },
      },
      visualPrompt: 'ALICE waits at the window.',
      characters: [
        character('Alice', 'https://example.com/alice.png'),
        character('Bob', 'https://example.com/bob.png'),
      ],
      locations: [],
      elements: [],
    });
    expect(refs.map((r) => r.referenceImageUrl)).toEqual([
      'https://example.com/alice.png',
    ]);
    expect(refs[0]).toMatchObject({ role: 'character', token: 'Alice' });
  });

  it('still matches continuity tags when the prompt does not name the character', () => {
    const refs = buildShotImageReferenceImages({
      scene: {
        continuity: {
          characterTags: ['Alice'],
          elementTags: [],
          environmentTag: '',
        },
        originalScript: { extract: '' },
      },
      visualPrompt: 'A woman in a red coat waits at the window.',
      characters: [character('Alice', 'https://example.com/alice.png')],
      locations: [],
      elements: [],
    });
    expect(refs.map((r) => r.referenceImageUrl)).toEqual([
      'https://example.com/alice.png',
    ]);
  });
});

const location = (
  name: string,
  referenceImageUrl: string
): SequenceLocationMinimal => ({
  id: `loc-${name}`,
  locationId: name.toLowerCase(),
  name,
  referenceImageUrl,
  referenceStatus: 'completed',
  referenceInputHash: 'hash',
  selectedReferenceVersionId: null,
  description: `${name} description`,
  consistencyTag: name.toLowerCase(),
});

describe('buildMotionReferenceImages — reference-only', () => {
  const scene = {
    continuity: { characterTags: ['Alice'], environmentTag: 'Rooftop' },
    originalScript: { extract: '' },
    metadata: { location: 'Rooftop' },
  };
  const characters = [character('Alice', 'https://example.com/alice.png')];
  const locations = [location('Rooftop', 'https://example.com/rooftop.png')];

  it('leaves locations out on the image-to-video path', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene,
      characters,
      elements: [],
      locations,
    });

    expect(refs.map((r) => r.role)).toEqual(['character']);
  });

  it('attaches the location sheet first when there is no still', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene,
      characters,
      elements: [],
      includeLocations: true,
      locations,
    });

    // Location leads: the reference budget is spent in order, so the set
    // should survive a cast that overflows it.
    expect(refs.map((r) => r.role)).toEqual(['location', 'character']);
    expect(refs[0]?.referenceImageUrl).toBe('https://example.com/rooftop.png');
  });

  it('is a no-op when the mode is on but no locations were loaded', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene,
      characters,
      elements: [],
      includeLocations: true,
    });

    expect(refs.map((r) => r.role)).toEqual(['character']);
  });
});

describe('buildMotionReferenceImages — prompt-named cast (#1432)', () => {
  // The image path gained this in #1432: continuity tags can be empty on a
  // scene that plainly names its cast. Motion did not follow, and in
  // reference-only there is no still to fall back on — an unmatched character
  // is reinvented outright, at full price, with nothing saying why.
  const untaggedScene = {
    continuity: { characterTags: [], elementTags: [] },
    originalScript: { extract: '' },
  };
  const cast = [
    character('Alice', 'https://example.com/alice.png'),
    character('Bob', 'https://example.com/bob.png'),
  ];

  it('attaches a character the prompt names but the tags miss', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: 'ALICE turns from the window as the light shifts.',
      scene: untaggedScene,
      characters: cast,
      elements: [],
    });
    expect(refs.map((r) => r.referenceImageUrl)).toEqual([
      'https://example.com/alice.png',
    ]);
  });

  it('attaches nothing without the prompt — the bug this fixes', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: null,
      scene: untaggedScene,
      characters: cast,
      elements: [],
    });
    expect(refs).toEqual([]);
  });

  it('does not duplicate a character both tagged and named', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: 'ALICE turns from the window.',
      scene: {
        continuity: { characterTags: ['Alice'], elementTags: [] },
        originalScript: { extract: '' },
      },
      characters: cast,
      elements: [],
    });
    expect(refs).toHaveLength(1);
  });
});

describe('buildMotionReferenceImages — element refs are additive', () => {
  // The image-to-video motion prompt deliberately never names what the start
  // frame already shows, so prompt-wins matching (right for the still) would
  // drop every tagged prop from the clip.
  it('keeps a tagged element the motion prompt does not name', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: 'Slow push in as she turns toward the window.',
      scene: {
        continuity: { characterTags: [], elementTags: ['LOGO'] },
        originalScript: { extract: '' },
      },
      characters: [],
      elements: [element('LOGO', 'https://example.com/logo.png')],
    });
    expect(refs.map((r) => r.referenceImageUrl)).toEqual([
      'https://example.com/logo.png',
    ]);
  });

  it('adds an element the prompt names but the tags miss, without duplicating', () => {
    const refs = buildMotionReferenceImages({
      motionPrompt: 'She lifts the PHONE while the LOGO glows behind her.',
      scene: {
        continuity: { characterTags: [], elementTags: ['LOGO'] },
        originalScript: { extract: '' },
      },
      characters: [],
      elements: [
        element('LOGO', 'https://example.com/logo.png'),
        element('PHONE', 'https://example.com/phone.png'),
      ],
    });
    expect(refs.map((r) => r.referenceImageUrl)).toEqual([
      'https://example.com/logo.png',
      'https://example.com/phone.png',
    ]);
  });
});
