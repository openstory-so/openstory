import { describe, expect, it } from 'vitest';
import { estimateStudioProgress } from './progress';

describe('estimateStudioProgress', () => {
  const createdAt = new Date(1_000_000);
  const at = (ms: number) => createdAt.getTime() + ms;

  it('starts at zero and never reports done', () => {
    expect(estimateStudioProgress('image', createdAt, at(0))).toBe(0);
    expect(estimateStudioProgress('image', createdAt, at(-5_000))).toBe(0);
    expect(estimateStudioProgress('video', createdAt, at(60 * 60_000))).toBe(
      99
    );
  });

  it('reaches half at one half-life and three quarters at two', () => {
    expect(estimateStudioProgress('image', createdAt, at(5_000))).toBe(50);
    expect(estimateStudioProgress('image', createdAt, at(10_000))).toBe(75);
    expect(estimateStudioProgress('video', createdAt, at(40_000))).toBe(50);
  });
});
