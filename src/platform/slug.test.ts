import { describe, expect, it } from 'vitest';
import { generateId, isValidId } from './id';
import { slugify, uniqueSlug } from './slug';

describe('slugify', () => {
  it('lowercases, strips diacritics and joins words with dashes', () => {
    expect(slugify('  The Café — Chase! ')).toBe('the-cafe-chase');
    expect(slugify("Marlowe's Office #2")).toBe('marlowe-s-office-2');
  });

  it('falls back to untitled when nothing is left', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('東京 !!')).toBe('untitled');
  });

  it('caps at 60 characters on a dash boundary', () => {
    const slug = slugify('word '.repeat(30));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.endsWith('word')).toBe(true);
  });

  it('never looks like a ULID', () => {
    expect(isValidId(slugify(generateId()))).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('suffixes -2, -3 on collision', () => {
    expect(uniqueSlug('a', new Set())).toBe('a');
    expect(uniqueSlug('a', new Set(['a']))).toBe('a-2');
    expect(uniqueSlug('a', new Set(['a', 'a-2']))).toBe('a-3');
  });
});
