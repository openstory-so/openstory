// Pin the gain math that backs the #834 music on/off toggle. The engine routes
// only the music node through this value; scene/dialogue audio is unaffected.
import { describe, expect, it } from 'vitest';

import { computeMusicGain, loudnessDbToLinear } from './music-gain';

describe('computeMusicGain', () => {
  it('returns 0 when music is disabled, whatever the loudness (the #834 mute contract)', () => {
    expect(computeMusicGain(false, null)).toBe(0);
    expect(computeMusicGain(false, -6)).toBe(0);
    expect(computeMusicGain(false, 12)).toBe(0);
  });

  it('returns unity gain when enabled without loudness normalization', () => {
    expect(computeMusicGain(true, null)).toBe(1);
    expect(computeMusicGain(true, 0)).toBe(1);
  });

  it('converts a negative dB adjustment to its linear factor', () => {
    expect(computeMusicGain(true, -6)).toBeCloseTo(0.501, 3);
  });

  it('converts a positive dB adjustment to its linear factor', () => {
    expect(computeMusicGain(true, 6)).toBeCloseTo(1.995, 3);
  });

  it('falls back to unity gain for non-finite loudness values', () => {
    expect(computeMusicGain(true, Number.NaN)).toBe(1);
    expect(computeMusicGain(true, Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('loudnessDbToLinear', () => {
  it('treats null and non-finite values as unity gain', () => {
    expect(loudnessDbToLinear(null)).toBe(1);
    expect(loudnessDbToLinear(Number.NaN)).toBe(1);
    expect(loudnessDbToLinear(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it('maps 0 dB to unity and ±6 dB to the expected linear factors', () => {
    expect(loudnessDbToLinear(0)).toBe(1);
    expect(loudnessDbToLinear(-6)).toBeCloseTo(0.501, 3);
    expect(loudnessDbToLinear(6)).toBeCloseTo(1.995, 3);
  });
});
