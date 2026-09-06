import { describe, expect, it } from 'vitest';
import { computeWordDiff } from './word-diff';

describe('computeWordDiff', () => {
  it('returns a single equal segment when inputs match', () => {
    const result = computeWordDiff('the cat sat', 'the cat sat');
    expect(result).toEqual([{ kind: 'eq', text: 'the cat sat' }]);
  });

  it('marks added words', () => {
    const result = computeWordDiff('cat sat', 'cat sat down');
    expect(
      result.some((s) => s.kind === 'add' && s.text.includes('down'))
    ).toBe(true);
  });

  it('marks removed words', () => {
    const result = computeWordDiff('cat sat down', 'cat sat');
    expect(
      result.some((s) => s.kind === 'del' && s.text.includes('down'))
    ).toBe(true);
  });

  it('handles full replacement', () => {
    const result = computeWordDiff('hello', 'world');
    expect(result.some((s) => s.kind === 'del' && s.text === 'hello')).toBe(
      true
    );
    expect(result.some((s) => s.kind === 'add' && s.text === 'world')).toBe(
      true
    );
  });

  it('handles empty before', () => {
    const result = computeWordDiff('', 'fresh prompt');
    expect(result.every((s) => s.kind === 'add' || s.kind === 'eq')).toBe(true);
    expect(result.some((s) => s.kind === 'add')).toBe(true);
  });

  it('handles empty after', () => {
    const result = computeWordDiff('old prompt', '');
    expect(result.some((s) => s.kind === 'del')).toBe(true);
  });
});
