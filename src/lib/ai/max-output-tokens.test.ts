/**
 * Regression tests for #1308 — `max_tokens` was derived as
 * `getContextWindow(model) * 0.5`, conflating the CONTEXT window with the
 * OUTPUT ceiling. Prod sent 500,000 for `claude-opus-5`, whose real
 * completion ceiling is 128,000; Gemini would have been sent 8× its ceiling.
 */
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_MODEL_IDS,
  getContextWindow,
  getMaxOutputTokens,
  SCRIPT_ANALYSIS_MODELS,
} from '@/lib/ai/models.config';

describe('getMaxOutputTokens', () => {
  it('never exceeds any model’s real completion ceiling', () => {
    for (const model of SCRIPT_ANALYSIS_MODELS) {
      expect(getMaxOutputTokens(model.id)).toBeLessThanOrEqual(
        model.maxOutputTokens
      );
      expect(getMaxOutputTokens(model.id, 0.65)).toBeLessThanOrEqual(
        model.maxOutputTokens
      );
      // The whole point: asking for the entire window still clamps.
      expect(getMaxOutputTokens(model.id, 1)).toBeLessThanOrEqual(
        model.maxOutputTokens
      );
    }
  });

  it('clamps the default analysis model instead of sending 500k', () => {
    // The exact prod bug: half of a 1M context window.
    expect(Math.floor(getContextWindow('anthropic/claude-opus-5') * 0.5)).toBe(
      500_000
    );
    expect(getMaxOutputTokens('anthropic/claude-opus-5')).toBe(128_000);
  });

  it('keeps the fraction when it is below the ceiling', () => {
    // deepseek-v3.2: 163,840 context, 147,456 ceiling — half the window
    // (81,920) is legal, so the fraction still governs.
    expect(getMaxOutputTokens('deepseek/deepseek-v3.2')).toBe(81_920);
  });

  it('is conservative for an unknown model', () => {
    expect(getMaxOutputTokens('some/unlisted-model')).toBe(32_000);
  });

  it('always returns a positive budget', () => {
    for (const id of ANALYSIS_MODEL_IDS) {
      expect(getMaxOutputTokens(id, 0)).toBeGreaterThan(0);
      expect(getMaxOutputTokens(id, -1)).toBeGreaterThan(0);
    }
  });
});
