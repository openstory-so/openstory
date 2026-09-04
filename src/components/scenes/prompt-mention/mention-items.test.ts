import { describe, expect, it } from 'vitest';
import {
  buildMentionItems,
  filterMentionItems,
  mentionInsertAttrs,
  SECTION_ORDER,
  type MentionCharacterInput,
  type MentionElementInput,
  type MentionLocationInput,
} from './mention-items';

const noopCharacter: MentionCharacterInput = {
  id: 'c1',
  characterId: 'char_001',
  name: 'Jack',
  consistencyTag: 'char_001: jack-denim-jacket',
  sheetImageUrl: null,
};

const noopElement: MentionElementInput = {
  id: 'e1',
  token: 'red-hex-logo',
  description: 'A red hex logo',
  imageUrl: 'https://example.com/logo.png',
  consistencyTag: null,
};

const noopLocation: MentionLocationInput = {
  id: 'l1',
  locationId: 'loc_001',
  name: 'INT. OFFICE',
  consistencyTag: 'loc_001: office-modern-steel',
  referenceImageUrl: null,
};

describe('buildMentionItems', () => {
  it('produces canonical tags: element token, cast name, location slug', () => {
    const items = buildMentionItems({
      characters: [noopCharacter],
      elements: [noopElement],
      locations: [noopLocation],
    });

    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    // Element tag IS the token verbatim (the script/prompt identifier).
    expect(byId['element:e1']?.tag).toBe('red-hex-logo');
    expect(byId['element:e1']?.section).toBe('elements');
    // Cast tag is the ALL-CAPS name; slug + id ride along as aliases.
    expect(byId['character:c1']?.tag).toBe('JACK');
    expect(byId['character:c1']?.section).toBe('cast');
    expect(byId['character:c1']?.aliases).toEqual([
      'jack-denim-jacket',
      'char_001',
    ]);
    expect(byId['location:l1']?.tag).toBe('office-modern-steel');
    expect(byId['location:l1']?.section).toBe('locations');
  });

  it('uses the UPPERCASE_SNAKE token verbatim as the element tag', () => {
    const items = buildMentionItems({
      characters: [],
      elements: [
        {
          ...noopElement,
          id: 'e2',
          token: 'RED_HEX_LOGO',
          consistencyTag: null,
        },
      ],
      locations: [],
    });
    const item = items.find((i) => i.id === 'element:e2');
    expect(item?.tag).toBe('RED_HEX_LOGO');
    expect(item?.aliases).toBeUndefined();
  });

  it('keeps the descriptive consistencyTag as a legacy alias', () => {
    const items = buildMentionItems({
      characters: [],
      elements: [
        {
          ...noopElement,
          id: 'e3',
          token: 'PEPSI_LOGO',
          consistencyTag: 'pepsi-cola-brand-logo',
        },
      ],
      locations: [],
    });
    const item = items.find((i) => i.id === 'element:e3');
    // Tag is the token; the old kebab consistencyTag still pills (legacy).
    expect(item?.tag).toBe('PEPSI_LOGO');
    expect(item?.aliases).toEqual(['pepsi-cola-brand-logo']);
  });

  it('uses the ALL-CAPS name for cast; falls back to locationId for locations', () => {
    const items = buildMentionItems({
      characters: [{ ...noopCharacter, consistencyTag: null }],
      elements: [],
      locations: [{ ...noopLocation, consistencyTag: null }],
    });
    // Cast tag is always the name — independent of consistencyTag.
    expect(items.find((i) => i.id === 'character:c1')?.tag).toBe('JACK');
    expect(items.find((i) => i.id === 'location:l1')?.tag).toBe('loc_001');
  });

  it('orders attached before elements, cast, locations, then library images', () => {
    expect(SECTION_ORDER).toEqual([
      'references',
      'elements',
      'cast',
      'locations',
      'images',
    ]);
  });
});

describe('filterMentionItems', () => {
  const items = buildMentionItems({
    characters: [noopCharacter],
    elements: [noopElement],
    locations: [noopLocation],
  });

  it('matches on the canonical tag', () => {
    expect(filterMentionItems(items, 'jack').map((i) => i.id)).toContain(
      'character:c1'
    );
  });

  it('matches on the human name (case-insensitive)', () => {
    expect(filterMentionItems(items, 'OFFICE').map((i) => i.id)).toContain(
      'location:l1'
    );
  });

  it('returns all items for empty query', () => {
    expect(filterMentionItems(items, '').length).toBe(items.length);
  });

  it('matches on the element kebab tag', () => {
    expect(filterMentionItems(items, 'red-hex').map((i) => i.id)).toContain(
      'element:e1'
    );
  });

  it('matches on the legacy uppercase-with-spaces element token via haystack', () => {
    const legacyItems = buildMentionItems({
      characters: [],
      elements: [
        {
          ...noopElement,
          id: 'e5',
          token: 'RED HEX LOGO',
          consistencyTag: null,
        },
      ],
      locations: [],
    });
    expect(
      filterMentionItems(legacyItems, 'RED HEX').map((i) => i.id)
    ).toContain('element:e5');
  });
});

describe('mentionInsertAttrs', () => {
  it('inserts the element token, not the dropdown row id', () => {
    const items = buildMentionItems({
      characters: [],
      elements: [{ ...noopElement, token: 'BONDI_SCREEN' }],
      locations: [],
    });
    const item = items.find((i) => i.id === 'element:e1');
    expect(item).toBeDefined();
    if (!item) throw new Error('expected element item');
    expect(mentionInsertAttrs(item)).toEqual({
      id: 'BONDI_SCREEN',
      section: 'elements',
      label: 'BONDI_SCREEN',
    });
  });

  it('inserts the ALL-CAPS cast name, not character:<id>', () => {
    const items = buildMentionItems({
      characters: [noopCharacter],
      elements: [],
      locations: [],
    });
    const item = items.find((i) => i.id === 'character:c1');
    expect(item).toBeDefined();
    if (!item) throw new Error('expected cast item');
    expect(mentionInsertAttrs(item)).toEqual({
      id: 'JACK',
      section: 'cast',
      label: 'Jack',
    });
  });

  it('passes through already-mapped attrs that have no tag field', () => {
    expect(
      mentionInsertAttrs({
        id: 'BONDI_SCREEN',
        section: 'elements',
        label: 'BONDI_SCREEN',
      })
    ).toEqual({
      id: 'BONDI_SCREEN',
      section: 'elements',
      label: 'BONDI_SCREEN',
    });
  });
});
