import { describe, expect, it, vi } from 'vitest';
import {
  isRegionBlockedLlmError,
  isRegionBlockedModel,
  REGION_FALLBACK_TEXT_MODEL,
  REGION_FALLBACK_VISION_MODEL,
  regionFallbackModel,
  resolveModelForCountry,
  withRegionFallback,
} from './region-policy';

describe('isRegionBlockedLlmError', () => {
  it('matches the real production error string (#1259)', () => {
    expect(
      isRegionBlockedLlmError(
        'LLM stream error [model=anthropic/claude-opus-5-fast]: This model is not available in your region.'
      )
    ).toBe(true);
  });

  it('matches the text-only fallback rejecting image input (#1323)', () => {
    expect(
      isRegionBlockedLlmError(
        'LLM stream error [model=deepseek/deepseek-v4-pro-0813]: No endpoints found that support image input'
      )
    ).toBe(true);
  });

  it('does not match other provider errors', () => {
    expect(isRegionBlockedLlmError('LLM stream error: 401 Unauthorized')).toBe(
      false
    );
    expect(isRegionBlockedLlmError('Provider returned error')).toBe(false);
  });
});

describe('regionFallbackModel', () => {
  it('falls back to DeepSeek for text calls', () => {
    expect(regionFallbackModel('anthropic/claude-opus-5-fast')).toBe(
      REGION_FALLBACK_TEXT_MODEL
    );
  });

  it('falls back to a vision-capable model for image-bearing calls', () => {
    expect(regionFallbackModel('anthropic/claude-sonnet-5', true)).toBe(
      REGION_FALLBACK_VISION_MODEL
    );
  });

  it('returns null when the failed model already is the fallback', () => {
    expect(regionFallbackModel(REGION_FALLBACK_TEXT_MODEL)).toBeNull();
    expect(regionFallbackModel(REGION_FALLBACK_VISION_MODEL, true)).toBeNull();
  });
});

describe('resolveModelForCountry', () => {
  it('swaps Anthropic models for blocked countries', () => {
    expect(resolveModelForCountry('anthropic/claude-opus-5', 'CN')).toBe(
      REGION_FALLBACK_TEXT_MODEL
    );
  });

  it('keeps non-Anthropic models even in blocked countries', () => {
    expect(resolveModelForCountry('x-ai/grok-4.6', 'CN')).toBe('x-ai/grok-4.6');
  });

  it('passes through outside blocked countries and without a header', () => {
    expect(resolveModelForCountry('anthropic/claude-opus-5', 'US')).toBe(
      'anthropic/claude-opus-5'
    );
    expect(resolveModelForCountry('anthropic/claude-opus-5', null)).toBe(
      'anthropic/claude-opus-5'
    );
  });
});

describe('isRegionBlockedModel', () => {
  it('blocks only Anthropic models in blocked countries', () => {
    expect(isRegionBlockedModel('anthropic/claude-opus-5', 'CN')).toBe(true);
    expect(isRegionBlockedModel('x-ai/grok-4.6', 'CN')).toBe(false);
    expect(isRegionBlockedModel('anthropic/claude-opus-5', 'US')).toBe(false);
    expect(isRegionBlockedModel('anthropic/claude-opus-5', undefined)).toBe(
      false
    );
  });
});

describe('withRegionFallback', () => {
  it('retries once with the fallback model on a region block', async () => {
    const run = vi
      .fn<(model: string) => Promise<string>>()
      .mockRejectedValueOnce(
        new Error('This model is not available in your region.')
      )
      .mockResolvedValueOnce('ok');
    await expect(
      withRegionFallback('anthropic/claude-opus-5', false, run)
    ).resolves.toBe('ok');
    expect(run).toHaveBeenNthCalledWith(1, 'anthropic/claude-opus-5');
    expect(run).toHaveBeenNthCalledWith(2, REGION_FALLBACK_TEXT_MODEL);
  });

  it('rethrows non-region errors untouched', async () => {
    const run = vi.fn().mockRejectedValue(new Error('402 out of credits'));
    await expect(
      withRegionFallback('anthropic/claude-opus-5', false, run)
    ).rejects.toThrow('402 out of credits');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rethrows when the fallback itself is region-blocked', async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new Error('not available in your region'));
    await expect(
      withRegionFallback(REGION_FALLBACK_TEXT_MODEL, false, run)
    ).rejects.toThrow('not available in your region');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
