import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_REGION_BLOCK_TTL_MS,
  isGoogleRegionBlockedError,
  isGoogleRegionBlockedHere,
  isGoogleRegionBlockedMessage,
  markGoogleRegionBlocked,
  resetGoogleRegionBlock,
  withGoogleRegionFallback,
} from './google-region';

/** Google's refusal as `@google/genai` throws it (production, 2026-10-28). */
const REFUSAL = new Error(
  '400 User location is not supported for the API use.'
);

afterEach(() => {
  resetGoogleRegionBlock();
  vi.useRealTimers();
});

describe('isGoogleRegionBlockedMessage', () => {
  it('matches the refusal as the SDK and the stream wrapper word it', () => {
    expect(isGoogleRegionBlockedMessage(REFUSAL.message)).toBe(true);
    expect(
      isGoogleRegionBlockedMessage(
        'LLM stream error [model=google/gemini-3.8-flash]: 400 User location is not supported for the API use.'
      )
    ).toBe(true);
    expect(
      isGoogleRegionBlockedMessage(
        '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}'
      )
    ).toBe(true);
  });

  it('does not match other 400s or the Anthropic region block', () => {
    expect(
      isGoogleRegionBlockedMessage('400 Invalid value at generation_config')
    ).toBe(false);
    expect(
      isGoogleRegionBlockedMessage(
        'This model is not available in your region.'
      )
    ).toBe(false);
  });
});

describe('isGoogleRegionBlockedError', () => {
  it('reads the message off the error and down its cause chain', () => {
    expect(isGoogleRegionBlockedError(REFUSAL)).toBe(true);
    expect(
      isGoogleRegionBlockedError(
        new Error('Image generation failed', { cause: REFUSAL })
      )
    ).toBe(true);
    expect(isGoogleRegionBlockedError(new Error('429 quota'))).toBe(false);
    expect(isGoogleRegionBlockedError('not an error')).toBe(false);
  });
});

describe('the isolate memo', () => {
  it('is off until a refusal is recorded', () => {
    expect(isGoogleRegionBlockedHere()).toBe(false);
  });

  it('keeps the via off for the TTL, then lets a call probe Google again', () => {
    markGoogleRegionBlocked('test', REFUSAL, 1_000);
    expect(isGoogleRegionBlockedHere(1_000)).toBe(true);
    expect(
      isGoogleRegionBlockedHere(1_000 + GOOGLE_REGION_BLOCK_TTL_MS - 1)
    ).toBe(true);
    expect(isGoogleRegionBlockedHere(1_000 + GOOGLE_REGION_BLOCK_TTL_MS)).toBe(
      false
    );
  });

  it('extends the block on a later refusal', () => {
    markGoogleRegionBlocked('test', REFUSAL, 1_000);
    markGoogleRegionBlocked('test', REFUSAL, 5_000);
    expect(
      isGoogleRegionBlockedHere(5_000 + GOOGLE_REGION_BLOCK_TTL_MS - 1)
    ).toBe(true);
  });
});

describe('withGoogleRegionFallback', () => {
  it('records the refusal and runs the call once more', async () => {
    const seen: boolean[] = [];
    const run = vi.fn(async () => {
      seen.push(isGoogleRegionBlockedHere());
      if (seen.length === 1) throw REFUSAL;
      return 'from fal';
    });
    await expect(withGoogleRegionFallback('test', run)).resolves.toBe(
      'from fal'
    );
    // The first attempt saw Google open; the second ran with the memo set,
    // so a resolver inside it would have chosen the no-key via.
    expect(seen).toEqual([false, true]);
  });

  it('rethrows any other error on the first throw', async () => {
    const run = vi.fn(async () => {
      throw new Error('429 Resource has been exhausted');
    });
    await expect(withGoogleRegionFallback('test', run)).rejects.toThrow(
      'exhausted'
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(isGoogleRegionBlockedHere()).toBe(false);
  });

  it('does not loop: a refusal while already marked is the error', async () => {
    markGoogleRegionBlocked('earlier', REFUSAL);
    const run = vi.fn(async () => {
      throw REFUSAL;
    });
    await expect(withGoogleRegionFallback('test', run)).rejects.toBe(REFUSAL);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('surfaces the second attempt’s own failure', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(REFUSAL)
      .mockRejectedValueOnce(new Error('fal: 422 content flagged'));
    await expect(withGoogleRegionFallback('test', run)).rejects.toThrow(
      'content flagged'
    );
    expect(run).toHaveBeenCalledTimes(2);
  });
});
