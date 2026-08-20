import { describe, expect, it } from 'vitest';

import { Seedance25ImageToVideoInputSchema } from './generated/schemas.gen';
import { getDurationValues, numericOf, snapTo } from './motion-transform';

describe('getDurationValues', () => {
  it('excludes non-numeric enum values like "auto"', () => {
    const values = getDurationValues(Seedance25ImageToVideoInputSchema);
    expect(values).not.toContain('auto');
    expect(values).toContain('4');
    expect(values).toContain('15');
  });
});

describe('snapTo', () => {
  it('filters out non-numeric values', () => {
    expect(snapTo(4, ['auto', '4', '5'])).toBe('4');
  });
});

describe('numericOf', () => {
  it('returns NaN for "auto"', () => {
    expect(numericOf('auto')).toBeNaN();
  });

  it('parses string numbers', () => {
    expect(numericOf('5')).toBe(5);
  });
});
