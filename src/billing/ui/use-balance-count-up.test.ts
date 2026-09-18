import { describe, expect, it } from 'vitest';
import { shownDuringGain } from './use-balance-count-up';

describe('shownDuringGain', () => {
  it('starts at the balance before the gift and ends on the balance', () => {
    expect(shownDuringGain(25, 20, 0)).toBe(5);
    expect(shownDuringGain(25, 20, 1)).toBe(25);
  });

  it('only ever counts up', () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map((p) =>
      shownDuringGain(20, 20, p)
    );
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it('holds at zero while the cache still has the old balance', () => {
    expect(shownDuringGain(0, 20, 0.5)).toBe(0);
  });
});
