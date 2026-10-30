import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_REGION_BLOCK_TTL_MS,
  isGoogleRegionBlockedError,
  isGoogleRegionBlockedHere,
  isGoogleRegionBlockedMessage,
  markGoogleRegionBlocked,
  refuseGeminiOffRegion,
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
    // The retry runs with the memo set, so its resolvers skip Google.
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

  it('retries a call that was in flight when a sibling set the mark', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(async () => {
        markGoogleRegionBlocked('sibling', REFUSAL);
        throw REFUSAL;
      })
      .mockResolvedValueOnce('from fal');
    await expect(withGoogleRegionFallback('test', run)).resolves.toBe(
      'from fal'
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retries every call of a fan-out refused at once', async () => {
    let refusalsLeft = 3;
    const run = async () => {
      const onGoogle = !isGoogleRegionBlockedHere();
      await Promise.resolve();
      if (onGoogle && refusalsLeft-- > 0) throw REFUSAL;
      return onGoogle ? 'google' : 'fal';
    };
    await expect(
      Promise.all([1, 2, 3].map(() => withGoogleRegionFallback('test', run)))
    ).resolves.toEqual(['fal', 'fal', 'fal']);
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

describe('refuseGeminiOffRegion', () => {
  it('marks the isolate and says the region is refused', async () => {
    await expect(
      refuseGeminiOffRegion('test', async () => {
        throw REFUSAL;
      })
    ).rejects.toThrow("Gemini isn't available from this region.");
    expect(isGoogleRegionBlockedHere()).toBe(true);
  });

  it('rethrows any other error untouched', async () => {
    const other = new Error('429 quota');
    await expect(
      refuseGeminiOffRegion('test', async () => {
        throw other;
      })
    ).rejects.toBe(other);
    expect(isGoogleRegionBlockedHere()).toBe(false);
  });

  it('keeps its own error when a sibling marked the isolate mid-flight', async () => {
    const other = new Error('503 unavailable');
    await expect(
      refuseGeminiOffRegion('test', async () => {
        markGoogleRegionBlocked('sibling', REFUSAL);
        throw other;
      })
    ).rejects.toBe(other);
  });
});
