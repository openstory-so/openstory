import { describe, expect, it } from 'vitest';
import { selectFilesToAccept } from './element-selector';
import { MAX_SEQUENCE_ELEMENTS } from '@/lib/sequence-elements/limits';
import { getFileKey } from '@/lib/utils/upload';

// Pinned lastModified so keys (`name-lastModified`) are deterministic.
const file = (name: string) => new File([], name, { lastModified: 1 });

describe('selectFilesToAccept', () => {
  it('accepts new files and skips duplicates (existing and within the batch)', () => {
    const accepted = selectFilesToAccept(
      [file('a'), file('b'), file('a'), file('c')],
      new Set([getFileKey(file('b'))]),
      1
    );
    expect(accepted.map((e) => e.key)).toEqual([
      getFileKey(file('a')),
      getFileKey(file('c')),
    ]);
  });

  it('caps at MAX_SEQUENCE_ELEMENTS counting existing elements', () => {
    const files = Array.from({ length: MAX_SEQUENCE_ELEMENTS }, (_, i) =>
      file(`f${i}`)
    );
    const accepted = selectFilesToAccept(
      files,
      new Set(),
      MAX_SEQUENCE_ELEMENTS - 2
    );
    expect(accepted).toHaveLength(2);
  });

  it('accepts nothing at or over the cap', () => {
    expect(
      selectFilesToAccept([file('a')], new Set(), MAX_SEQUENCE_ELEMENTS)
    ).toEqual([]);
    expect(
      selectFilesToAccept([file('a')], new Set(), MAX_SEQUENCE_ELEMENTS + 1)
    ).toEqual([]);
  });
});
