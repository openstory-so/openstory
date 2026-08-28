import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDeadlineFetch,
  createFalTimeoutError,
  falTimeoutMessage,
  isFalTimeoutError,
} from './fal-deadline-fetch';

describe('fal-deadline-fetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('falTimeoutMessage / createFalTimeoutError format the deadline clearly', () => {
    expect(falTimeoutMessage('Image generation', 600_000)).toBe(
      'Image generation timed out after 600s'
    );
    expect(
      isFalTimeoutError(createFalTimeoutError('Image generation', 10_000))
    ).toBe(true);
    expect(isFalTimeoutError(new Error('something else'))).toBe(false);
  });

  it('resolves when the underlying fetch completes within the deadline', async () => {
    const response = new Response('ok');
    globalThis.fetch = vi.fn(async () => response);

    const deadlineFetch = createDeadlineFetch(5_000, 'Test request');
    const result = await deadlineFetch('https://example.com');

    expect(result).toBe(response);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('aborts a hung fetch once the wall-clock deadline elapses', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          capturedSignal = init?.signal ?? undefined;
          const onAbort = () => {
            reject(
              new DOMException('The operation was aborted.', 'AbortError')
            );
          };
          if (capturedSignal?.aborted) {
            onAbort();
            return;
          }
          capturedSignal?.addEventListener('abort', onAbort, { once: true });
        })
    );

    const deadlineFetch = createDeadlineFetch(1_000, 'Image generation');
    const pending = deadlineFetch('https://queue.fal.run/test');
    // Attach the assertion before advancing timers so the rejection is
    // handled synchronously with the abort (avoids unhandled-rejection noise).
    const assertion = expect(pending).rejects.toThrow(
      'Image generation timed out after 1s'
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('rejects immediately when the deadline has already expired', async () => {
    globalThis.fetch = vi.fn(async () => new Response('ok'));

    const deadlineFetch = createDeadlineFetch(1_000, 'Music generation');
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(deadlineFetch('https://example.com')).rejects.toThrow(
      'Music generation timed out after 1s'
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('forwards parent AbortSignal cancellation', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          capturedSignal = init?.signal ?? undefined;
          const onAbort = () => {
            reject(
              new DOMException('The operation was aborted.', 'AbortError')
            );
          };
          if (capturedSignal?.aborted) {
            onAbort();
            return;
          }
          capturedSignal?.addEventListener('abort', onAbort, { once: true });
        })
    );

    const parent = new AbortController();
    const deadlineFetch = createDeadlineFetch(60_000, 'Test request');
    const pending = deadlineFetch('https://example.com', {
      signal: parent.signal,
    });
    const assertion = expect(pending).rejects.toThrow('caller cancelled');

    parent.abort(new Error('caller cancelled'));
    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('shares one wall-clock budget across sequential fetches', async () => {
    const responses = [new Response('1'), new Response('2')];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      const response = responses[call];
      call += 1;
      if (!response) throw new Error('unexpected fetch');
      return response;
    });

    const deadlineFetch = createDeadlineFetch(2_000, 'Image generation');

    await deadlineFetch('https://example.com/a');
    // Burn most of the budget between polls (as fal.subscribe would).
    await vi.advanceTimersByTimeAsync(1_500);
    await deadlineFetch('https://example.com/b');

    // Budget exhausted — next poll fails without calling fetch.
    await vi.advanceTimersByTimeAsync(600);
    await expect(deadlineFetch('https://example.com/c')).rejects.toThrow(
      'Image generation timed out after 2s'
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
