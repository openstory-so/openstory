import { describe, expect, it } from 'vitest';
import { replaceConfirmCopy } from './character-replace-dialog';

describe('replaceConfirmCopy', () => {
  it('says the slot stays when the pick is not in this sequence', () => {
    const copy = replaceConfirmCopy('Marloe', 'Ada', false);
    expect(copy.title).toBe('Replace Marloe with Ada?');
    expect(copy.description).toContain('Scenes stay on this slot');
    expect(copy.description).toContain('Shots that used this slot go stale');
    expect(copy.description).toContain('Nothing is copied');
  });

  it('says this card is dropped when the pick is already cast', () => {
    const copy = replaceConfirmCopy('Marloe', 'Ada', true);
    expect(copy.description).toContain('This card is dropped');
    expect(copy.description).toContain('remembered there');
    expect(copy.description).not.toContain('Scenes stay on this slot');
  });
});
