import { describe, expect, it } from 'vitest';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { findMentionItem, replacementItems } from './mention-edit-popover';

const item = (
  over: Partial<MentionItem> & Pick<MentionItem, 'id' | 'section' | 'tag'>
): MentionItem => ({
  label: over.tag,
  haystack: over.tag.toLowerCase(),
  ...over,
});

const ELEMENT = item({
  id: 'element:1',
  section: 'elements',
  tag: 'BONDI_SCREEN',
});
const LEGACY = item({
  id: 'element:2',
  section: 'elements',
  tag: 'RED_HEX',
  aliases: ['red-hex-logo'],
});
const CAST = item({ id: 'character:1', section: 'cast', tag: 'JACK' });
const LOCATION = item({
  id: 'location:1',
  section: 'locations',
  tag: 'office-modern',
});

const ITEMS = [ELEMENT, LEGACY, CAST, LOCATION];

describe('findMentionItem', () => {
  it('resolves a pill by its canonical tag', () => {
    expect(findMentionItem(ITEMS, { id: 'JACK', section: 'cast' })).toBe(CAST);
  });

  it('resolves a stale lowercased tag', () => {
    expect(
      findMentionItem(ITEMS, { id: 'bondi_screen', section: 'elements' })
    ).toBe(ELEMENT);
  });

  it('falls back to a legacy alias', () => {
    expect(
      findMentionItem(ITEMS, { id: 'red-hex-logo', section: 'elements' })
    ).toBe(LEGACY);
  });

  it('ignores items from another section', () => {
    expect(
      findMentionItem(ITEMS, { id: 'JACK', section: 'elements' })
    ).toBeUndefined();
  });

  it('is undefined for a half-typed pill', () => {
    expect(findMentionItem(ITEMS, { id: null, section: null })).toBeUndefined();
  });
});

describe('replacementItems', () => {
  it('drops the current target and groups by section order', () => {
    const rows = replacementItems(ITEMS, ELEMENT, '');
    expect(rows.map((r) => r.id)).toEqual([
      'element:2',
      'character:1',
      'location:1',
    ]);
  });

  it('filters on the query', () => {
    expect(replacementItems(ITEMS, ELEMENT, 'jac').map((r) => r.id)).toEqual([
      'character:1',
    ]);
  });
});
