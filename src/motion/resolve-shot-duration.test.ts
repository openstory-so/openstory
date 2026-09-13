import { describe, expect, it } from 'vitest';

import { resolveShotDuration } from './resolve-shot-duration';

// kling_v3_pro accepts integer seconds 1..15 (one entry per integer).
// gemini_omni_flash accepts only 3..10 — useful for asserting snap behavior.

describe('resolveShotDuration', () => {
  it('uses explicit duration when present, snapped to the model', () => {
    const result = resolveShotDuration({
      explicit: 12,
      durationMs: 3000,
      model: 'gemini_omni_flash',
    });
    expect(result).toBe(10);
  });

  it('falls back to durationMs/1000 when explicit is undefined', () => {
    const result = resolveShotDuration({
      durationMs: 5000,
      model: 'kling_v3_pro',
    });
    expect(result).toBe(5);
  });

  it('falls back to a valid model duration when nothing is stored', () => {
    const result = resolveShotDuration({ model: 'gemini_omni_flash' });
    expect(result).toBeGreaterThanOrEqual(3);
    expect(result).toBeLessThanOrEqual(10);
  });

  it('snaps onto the model duration set even when the source was valid for a different model', () => {
    // 12s is valid for kling_v3_pro but not for gemini_omni_flash
    const result = resolveShotDuration({
      durationMs: 12000,
      model: 'gemini_omni_flash',
    });
    expect(result).toBe(10);
  });
});
