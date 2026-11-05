import { describe, expect, it } from 'vitest';
import { replaceConfirmCopy } from './character-replace-dialog';

describe('replaceConfirmCopy', () => {
  it('says the slot stays and shots go stale', () => {
    const copy = replaceConfirmCopy('Marloe', 'Ada');
    expect(copy.title).toBe('Replace Marloe with Ada?');
    expect(copy.description).toContain('Scenes stay on this slot');
    expect(copy.description).toContain('Shots that used this slot go stale');
    expect(copy.description).toContain('Nothing is copied');
  });
});
