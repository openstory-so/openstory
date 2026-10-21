import { describe, expect, test } from 'vitest';

import { contentRangeHeader } from './content-range';

describe('contentRangeHeader', () => {
  test('an offset read ignores a present undefined suffix', () => {
    expect(
      contentRangeHeader({ offset: 0, length: 16, suffix: undefined }, 1715)
    ).toBe('bytes 0-15/1715');
  });

  test('an offset without a length runs to the end of the object', () => {
    expect(contentRangeHeader({ offset: 10 }, 1715)).toBe('bytes 10-1714/1715');
  });

  test('a suffix read is the last N bytes', () => {
    expect(contentRangeHeader({ suffix: 16 }, 1715)).toBe(
      'bytes 1699-1714/1715'
    );
  });
});
