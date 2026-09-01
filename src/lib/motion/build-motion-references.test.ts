import { describe, expect, it } from 'vitest';
import type { CharacterMinimal, SequenceElementMinimal } from '@/lib/db/schema';
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
