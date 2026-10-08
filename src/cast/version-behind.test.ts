import { describe, expect, it } from 'vitest';
import { isBehindCurrentVersion } from './version-behind';

const current = {
  selectedBibleVersionId: 'b1',
  currentBibleVersionId: 'b1',
  selectedVoiceVersionId: 'v1',
  currentVoiceVersionId: 'v1',
  looks: [{ deletedAt: null, lookVersionId: 'l1', currentLookVersionId: 'l1' }],
};

describe('isBehindCurrentVersion', () => {
  it('is false when every pin is current', () => {
    expect(isBehindCurrentVersion(current)).toBe(false);
  });
  it('is true when the bible, the voice or a live look pin differs', () => {
    expect(
      isBehindCurrentVersion({ ...current, currentBibleVersionId: 'b2' })
    ).toBe(true);
    expect(
      isBehindCurrentVersion({ ...current, currentVoiceVersionId: null })
    ).toBe(true);
    expect(
      isBehindCurrentVersion({
        ...current,
        looks: [
          { deletedAt: null, lookVersionId: 'l1', currentLookVersionId: 'l2' },
        ],
      })
    ).toBe(true);
  });
  it('ignores a removed look and a character with no current bible', () => {
    expect(
      isBehindCurrentVersion({
        ...current,
        currentBibleVersionId: null,
        looks: [
          {
            deletedAt: new Date(),
            lookVersionId: 'l1',
            currentLookVersionId: 'l2',
          },
        ],
      })
    ).toBe(false);
  });
});
