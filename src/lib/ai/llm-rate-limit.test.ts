import { describe, expect, it, vi } from 'vitest';
import {
  isLlmRateLimitError,
  LLM_RATE_LIMIT_MAX_ATTEMPTS,
  LLM_RATE_LIMIT_MAX_DELAY_MS,
  llmRateLimitDelayMs,
  withLlmRateLimitRetry,
} from './llm-rate-limit';

const withStatus = (status: number, message = 'boom') =>
  Object.assign(new Error(message), { status });

describe('isLlmRateLimitError', () => {
  it('classifies a 429 status as a quota rejection', () => {
    expect(isLlmRateLimitError(withStatus(429))).toBe(true);
  });

  it('classifies the native Gemini RESOURCE_EXHAUSTED body', () => {
    expect(
      isLlmRateLimitError(
        new Error(
          'LLM stream error: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 429,\\n    \\"message\\": \\"Resource has been exhausted (e.g. check quota).\\""}}'
        )
      )
    ).toBe(true);
  });

  it.each([
    'google/gemini-3.7-flash is temporarily rate-limited',
    'Too Many Requests',
    'RESOURCE_EXHAUSTED',
  ])('classifies rate-limit text: %s', (message) => {
    expect(isLlmRateLimitError(new Error(message))).toBe(true);
  });

  it.each([
    withStatus(400, 'Invalid JSON schema'),
    new Error('content policy violation'),
    new Error('empty completion'),
  ])('does not classify a permanent failure as a rate limit', (error) => {
    expect(isLlmRateLimitError(error)).toBe(false);
  });
});

describe('llmRateLimitDelayMs', () => {
  it('doubles each attempt before jitter', () => {
    expect(llmRateLimitDelayMs(0, () => 0.5)).toBe(2_000);
    expect(llmRateLimitDelayMs(1, () => 0.5)).toBe(4_000);
    expect(llmRateLimitDelayMs(2, () => 0.5)).toBe(8_000);
  });

  it('caps so one wait cannot stall a workflow step', () => {
    expect(llmRateLimitDelayMs(20, () => 0.5)).toBe(
      LLM_RATE_LIMIT_MAX_DELAY_MS
    );
  });
});

describe('withLlmRateLimitRetry', () => {
  it('returns the first success without waiting', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withLlmRateLimitRetry('t', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and returns the eventual success', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(withStatus(429))
        .mockResolvedValue('ok');
      const promise = withLlmRateLimitRetry('t', fn);
      await vi.advanceTimersByTimeAsync(LLM_RATE_LIMIT_MAX_DELAY_MS);
      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a permanent error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('content policy violation'));
    await expect(withLlmRateLimitRetry('t', fn)).rejects.toThrow(
      /content policy/
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts the budget and rethrows', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue(withStatus(429));
      const promise = withLlmRateLimitRetry('t', fn);
      promise.catch(() => undefined);
      for (let i = 0; i < LLM_RATE_LIMIT_MAX_ATTEMPTS; i++) {
        await vi.advanceTimersByTimeAsync(LLM_RATE_LIMIT_MAX_DELAY_MS);
      }
      await expect(promise).rejects.toMatchObject({ status: 429 });
      expect(fn).toHaveBeenCalledTimes(LLM_RATE_LIMIT_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });
});
