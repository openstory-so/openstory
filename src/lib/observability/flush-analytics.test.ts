/**
 * `flushAnalytics` must never reject — `base-workflow` awaits it in a
 * `finally` while a real error is propagating, so a rejection here would
 * replace it. Middleware `finally` blocks depend on the same guarantee.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const flushAIObservability = vi.fn(() => Promise.resolve());
vi.doMock('./ai-otel', () => ({ flushAIObservability }));

// The contract is swallowed-BUT-LOGGED. Without asserting the log, every test
// below passes with the logging deleted, and a permanently broken exporter
// looks exactly like a healthy one.
const mockLogError = vi.fn(
  (_message: string, _properties?: Record<string, unknown>) => {}
);
const mockLogWarn = vi.fn(
  (_message: string, _properties?: Record<string, unknown>) => {}
);
vi.doMock('./logger', async () => {
  const real = await import('./logger');
  return {
    ...real,
    getLogger: () => ({
      error: mockLogError,
      warn: mockLogWarn,
      info: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const postHogFlush = vi.fn(() => Promise.resolve());
const getPostHogClient = vi.fn((): { flush: () => Promise<void> } | null => ({
  flush: postHogFlush,
}));
vi.doMock('@/lib/posthog-server', () => ({ getPostHogClient }));

const { flushAnalytics } = await import('./flush-analytics');

describe('flushAnalytics', () => {
  beforeEach(() => {
    mockLogError.mockClear();
    mockLogWarn.mockClear();
    postHogFlush.mockReset();
    postHogFlush.mockResolvedValue(undefined);
    flushAIObservability.mockReset();
    flushAIObservability.mockResolvedValue(undefined);
    getPostHogClient.mockReset();
    getPostHogClient.mockReturnValue({ flush: postHogFlush });
  });

  it('flushes both events and spans', async () => {
    await expect(flushAnalytics()).resolves.toBeUndefined();

    expect(postHogFlush).toHaveBeenCalledTimes(1);
    expect(flushAIObservability).toHaveBeenCalledTimes(1);
  });

  it('resolves when both flushes reject, and logs each', async () => {
    postHogFlush.mockRejectedValueOnce(new Error('posthog down'));
    flushAIObservability.mockRejectedValueOnce(new Error('otlp 401'));

    await expect(flushAnalytics()).resolves.toBeUndefined();

    expect(mockLogError).toHaveBeenCalledTimes(2);
  });

  it('logs the AggregateError causes, not just its summary message', async () => {
    // `flushAIObservability` rejects with an AggregateError whose reasons live
    // on `.errors`; `toErrorPayload` only walks `.cause`, so without explicit
    // flattening the log says "flush failed" and nothing about why.
    flushAIObservability.mockRejectedValueOnce(
      new AggregateError(
        [new Error('trace export 401'), new Error('metric export 401')],
        'AI observability flush failed'
      )
    );

    await flushAnalytics();

    const properties = mockLogError.mock.calls.at(-1)?.[1];
    expect(JSON.stringify(properties)).toContain('trace export 401');
    expect(JSON.stringify(properties)).toContain('metric export 401');
  });

  it('still runs the span flush when the event flush rejects', async () => {
    // allSettled, not all — one failing exporter must not strand the other.
    postHogFlush.mockRejectedValueOnce(new Error('posthog down'));
    flushAIObservability.mockClear();

    await expect(flushAnalytics()).resolves.toBeUndefined();

    expect(flushAIObservability).toHaveBeenCalledTimes(1);
  });

  it('resolves when getPostHogClient throws synchronously', async () => {
    // `getPostHogClient` constructs `new PostHog(...)` on first call. A throw
    // there happens while building the array literal, so it escapes
    // `allSettled` unless the call is wrapped in an async thunk.
    getPostHogClient.mockImplementationOnce(() => {
      throw new Error('PostHog constructor blew up');
    });

    await expect(flushAnalytics()).resolves.toBeUndefined();
  });

  it('resolves when PostHog is not configured', async () => {
    getPostHogClient.mockReturnValueOnce(null);

    await expect(flushAnalytics()).resolves.toBeUndefined();
  });

  /**
   * Never rejecting is not enough if it never SETTLES. Every caller awaits
   * this — base-workflow in a `finally`, the schedulers directly — and an
   * awaited promise with no pending I/O is precisely what the Workers runtime
   * kills as "hung and would never generate a response". Analytics is
   * expendable; the isolate is not.
   */
  describe('when a sink never settles', () => {
    it('still resolves, and says so', async () => {
      vi.useFakeTimers();
      let resolveHang: () => void = () => {};
      try {
        // Never resolves until we release it — the shape allSettled cannot
        // escape. Release after the assertion so the shared in-flight export
        // does not poison later tests.
        flushAIObservability.mockReturnValueOnce(
          new Promise<void>((resolve) => {
            resolveHang = resolve;
          })
        );

        const flushed = flushAnalytics();
        let settled = false;
        void flushed.then(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        await expect(flushed).resolves.toBeUndefined();
        expect(mockLogWarn).toHaveBeenCalledWith(
          expect.stringContaining('abandoning the batch')
        );
        expect(mockLogError).not.toHaveBeenCalled();
      } finally {
        resolveHang();
        await Promise.resolve();
        vi.useRealTimers();
      }
    });

    it('shares one export across concurrent waiters and logs the timeout once', async () => {
      vi.useFakeTimers();
      let resolveHang: () => void = () => {};
      try {
        flushAIObservability.mockReturnValue(
          new Promise<void>((resolve) => {
            resolveHang = resolve;
          })
        );

        const waiters = Array.from({ length: 20 }, () => flushAnalytics());
        await vi.advanceTimersByTimeAsync(5_001);
        await Promise.all(waiters);

        expect(flushAIObservability).toHaveBeenCalledTimes(1);
        expect(postHogFlush).toHaveBeenCalledTimes(1);
        expect(mockLogWarn).toHaveBeenCalledTimes(1);
      } finally {
        resolveHang();
        await Promise.resolve();
        vi.useRealTimers();
      }
    });

    it('does not wait for the timeout when both sinks settle', async () => {
      vi.useFakeTimers();
      try {
        const flushed = flushAnalytics();
        // No timer advance at all: a completed flush must not be gated on the
        // deadline, or every workflow would pay the timeout on teardown.
        await expect(flushed).resolves.toBeUndefined();
        expect(mockLogError).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
