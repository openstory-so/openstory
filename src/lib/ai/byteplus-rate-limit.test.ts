import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportBytePlusQuotaBackoff = vi.fn();
vi.doMock('@/lib/ai/byteplus-observability', () => ({
  reportBytePlusQuotaBackoff,
}));

const {
  BYTEPLUS_QUOTA_MAX_ATTEMPTS,
  bytePlusQuotaDelayMs,
  BYTEPLUS_QUOTA_MAX_DELAY_MS,
  isBytePlusQuotaError,
  withBytePlusQuotaRetry,
} = await import('./byteplus-rate-limit');

beforeEach(() => {
  reportBytePlusQuotaBackoff.mockClear();
});

const withStatus = (status: number, message = 'boom') =>
  Object.assign(new Error(message), { status });

describe('isBytePlusQuotaError', () => {
  it('classifies a 429 as a quota rejection', () => {
    expect(isBytePlusQuotaError(withStatus(429))).toBe(true);
  });

  it.each([
    'RateLimitExceeded: too many requests',
    'QuotaExceeded for this account',
    'ServerOverValue — concurrency limit reached',
  ])('classifies Ark quota text: %s', (message) => {
    expect(isBytePlusQuotaError(new Error(message))).toBe(true);
  });

  // These are permanent. Retrying them just delays the report by the full
  // backoff budget and hides the real cause behind a timeout.
  it.each([
    withStatus(400, 'InvalidParameter: size is malformed'),
    withStatus(404, 'InvalidEndpointOrModel.NotFound: ModelNotOpen'),
    new Error('content policy violation'),
  ])('does not classify a permanent failure as a quota rejection', (error) => {
    expect(isBytePlusQuotaError(error)).toBe(false);
  });
});

describe('bytePlusQuotaDelayMs', () => {
  it('doubles each attempt', () => {
    expect(bytePlusQuotaDelayMs(0)).toBe(2_000);
    expect(bytePlusQuotaDelayMs(1)).toBe(4_000);
    expect(bytePlusQuotaDelayMs(2)).toBe(8_000);
  });

  it('caps so one wait cannot stall a workflow step', () => {
    expect(bytePlusQuotaDelayMs(20)).toBe(BYTEPLUS_QUOTA_MAX_DELAY_MS);
  });
});

describe('withBytePlusQuotaRetry', () => {
  it('returns the first success without waiting', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withBytePlusQuotaRetry('t', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a quota rejection and returns the eventual success', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(withStatus(429))
        .mockResolvedValue('ok');
      const promise = withBytePlusQuotaRetry('t', fn);
      await vi.advanceTimersByTimeAsync(bytePlusQuotaDelayMs(0));
      await expect(promise).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The important half: a content rejection must reach the caller's re-roll
  // logic on the first throw, not after burning the whole backoff budget.
  it('rethrows a non-quota error immediately', async () => {
    const error = withStatus(422, 'content policy');
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withBytePlusQuotaRetry('t', fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap and rethrows the last quota error', async () => {
    vi.useFakeTimers();
    try {
      const error = withStatus(429);
      const fn = vi.fn().mockRejectedValue(error);
      const promise = withBytePlusQuotaRetry('t', fn);
      const assertion = expect(promise).rejects.toBe(error);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(BYTEPLUS_QUOTA_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Backoff is the only backpressure against Ark's per-account quota, so its
 * firing rate is the signal that tells us whether relying on it still holds.
 * Silence here would make "never fires" and "fires constantly" identical.
 */
describe('quota backoff instrumentation', () => {
  it('emits nothing when the call succeeds', async () => {
    await withBytePlusQuotaRetry('image generate', async () => 'ok');
    expect(reportBytePlusQuotaBackoff).not.toHaveBeenCalled();
  });

  it('emits nothing for a non-quota failure', async () => {
    await expect(
      withBytePlusQuotaRetry('image generate', async () => {
        throw withStatus(400, 'InvalidParameter');
      })
    ).rejects.toThrow();
    expect(reportBytePlusQuotaBackoff).not.toHaveBeenCalled();
  });

  it('emits a non-exhausted event per retried rejection', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(withStatus(429))
        .mockResolvedValue('ok');
      const promise = withBytePlusQuotaRetry('motion submit', fn);
      await vi.advanceTimersByTimeAsync(bytePlusQuotaDelayMs(0));
      await promise;
      expect(reportBytePlusQuotaBackoff).toHaveBeenCalledTimes(1);
      expect(reportBytePlusQuotaBackoff).toHaveBeenCalledWith({
        operation: 'motion submit',
        attempt: 1,
        delayMs: bytePlusQuotaDelayMs(0),
        exhausted: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // The exhausted event is the one that matters: it means a user saw a failed
  // shot, and a non-zero rate is the trigger to build real admission control.
  it('marks the final event exhausted when the budget runs out', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValue(withStatus(429));
      const promise = withBytePlusQuotaRetry('motion submit', fn);
      const assertion = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;

      const calls = reportBytePlusQuotaBackoff.mock.calls.map(([c]) => c);
      expect(calls).toHaveLength(BYTEPLUS_QUOTA_MAX_ATTEMPTS);
      expect(calls.filter((c) => c.exhausted)).toHaveLength(1);
      expect(calls.at(-1)).toEqual({
        operation: 'motion submit',
        attempt: BYTEPLUS_QUOTA_MAX_ATTEMPTS,
        exhausted: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
