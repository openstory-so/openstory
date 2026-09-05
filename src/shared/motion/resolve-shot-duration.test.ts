import { describe, expect, it } from 'vitest';

import { resolveShotDuration } from './resolve-shot-duration';

// kling_v3_pro accepts integer seconds 1..15 (one entry per integer).
// veo3_1 accepts only {4, 6, 8} — useful for asserting snap behavior.

describe('resolveShotDuration', () => {
  it('uses explicit duration when present, snapped to the model', () => {
    const result = resolveShotDuration({
      explicit: 7,
      durationMs: 3000,
      model: 'veo3_1',
    });
    // 7 is equidistant from 6 and 8; current snap tie-break keeps the earlier value.
    expect([6, 8]).toContain(result);
  });

  it('falls back to durationMs/1000 when explicit is undefined', () => {
    const result = resolveShotDuration({
      durationMs: 5000,
      model: 'kling_v3_pro',
    });
    expect(result).toBe(5);
  });

  it('falls back to a valid model duration when nothing is stored', () => {
    const result = resolveShotDuration({ model: 'veo3_1' });
    expect([4, 6, 8]).toContain(result);
  });

  it('snaps onto the model duration set even when the source was valid for a different model', () => {
    // 12s is valid for kling_v3_pro but not for veo3_1
    const result = resolveShotDuration({
      durationMs: 12000,
      model: 'veo3_1',
    });
    expect(result).toBe(8);
  });
});
