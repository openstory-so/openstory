import { describe, expect, it } from 'vitest';

import {
  dialogueExceedsShotDuration,
  raiseShotDurationToCoverAudio,
  resolveShotDuration,
} from './resolve-shot-duration';

// kling_v3_pro accepts integer seconds 1..15 (one entry per integer).
// gemini_omni_flash accepts only 3..15 — useful for asserting snap behavior.

describe('resolveShotDuration', () => {
  it('uses explicit duration when present, snapped to the model', () => {
    const result = resolveShotDuration({
      explicit: 20,
      durationMs: 3000,
      model: 'gemini_omni_flash',
    });
    expect(result).toBe(15);
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
    expect(result).toBeLessThanOrEqual(15);
  });

  it('snaps onto the model duration set even when the source was valid for a different model', () => {
    // 20s is valid for seedance_v2_5 but not for gemini_omni_flash
    const result = resolveShotDuration({
      durationMs: 20000,
      model: 'gemini_omni_flash',
    });
    expect(result).toBe(15);
  });
});

describe('raiseShotDurationToCoverAudio', () => {
  it('leaves the clip alone when the audio already fits', () => {
    expect(raiseShotDurationToCoverAudio(8, 6.2, 'seedance_v2_5')).toBe(8);
  });
  it('raises onto the next grid step that covers the audio', () => {
    expect(raiseShotDurationToCoverAudio(5, 6.2, 'seedance_v2_5')).toBe(7);
  });
});

describe('dialogueExceedsShotDuration', () => {
  it('is true only when the take is longer than the shot', () => {
    expect(dialogueExceedsShotDuration(6.2, 5)).toBe(true);
    expect(dialogueExceedsShotDuration(5, 5)).toBe(false);
    expect(dialogueExceedsShotDuration(2.4, 5)).toBe(false);
    expect(dialogueExceedsShotDuration(null, 5)).toBe(false);
    expect(dialogueExceedsShotDuration(6.2, undefined)).toBe(false);
  });
});
