import { describe, expect, it } from 'vitest';
import { excerpt } from './search';

describe('excerpt', () => {
  it('returns the first text that holds the query, whatever its case', () => {
    expect(excerpt([null, 'No match', 'A red Kite flies'], 'kite')).toBe(
      'A red Kite flies'
    );
  });

  it('cuts a long text to a window around the match', () => {
    const text = `${'a'.repeat(100)} lighthouse ${'b'.repeat(100)}`;
    const cut = excerpt([text], 'lighthouse');
    expect(cut).toMatch(/^…a+ lighthouse b+…$/);
    expect(cut?.length).toBeLessThan(100);
  });

  it('puts a text with line breaks on one line', () => {
    expect(excerpt(['Scene 1\n\nThe kite\nflies'], 'kite')).toBe(
      'Scene 1 The kite flies'
    );
  });

  it('is null when no text holds the query', () => {
    expect(excerpt(['only the title matched', undefined], 'kite')).toBeNull();
  });
});
