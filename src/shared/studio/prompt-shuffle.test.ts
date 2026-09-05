import { describe, expect, it } from 'vitest';
import { pickShufflePrompt, studioShufflePrompts } from './prompt-shuffle';

describe('studioShufflePrompts', () => {
  it('returns a non-empty pool for each activity', () => {
    expect(studioShufflePrompts('image').length).toBeGreaterThan(3);
    expect(studioShufflePrompts('video').length).toBeGreaterThan(3);
    expect(studioShufflePrompts('image')).not.toEqual(
      studioShufflePrompts('video')
    );
  });
});

describe('pickShufflePrompt', () => {
  const pool = ['alpha', 'bravo', 'charlie'] as const;

  it('never repeats the current prompt when another exists', () => {
    expect(pickShufflePrompt(pool, 'alpha', () => 0)).toBe('bravo');
    expect(pickShufflePrompt(pool, 'alpha', () => 0.99)).toBe('charlie');
  });

  it('picks across the full pool when the box is empty', () => {
    expect(pickShufflePrompt(pool, '', () => 0)).toBe('alpha');
    expect(pickShufflePrompt(pool, '  ', () => 0.99)).toBe('charlie');
  });

  it('returns the only prompt when the pool is a single item', () => {
    expect(pickShufflePrompt(['only'], 'only', () => 0)).toBe('only');
  });

  it('returns null for an empty pool', () => {
    expect(pickShufflePrompt([], '', () => 0)).toBeNull();
  });
});
