/**
 * Native-Grok mapping and pricing (issue #1167). xAI reports token counts but
 * no cost for chat and images, so unlike the OpenRouter path these functions
 * ARE the bill — a wrong figure here is a silent mischarge on every render.
 */

import { describe, expect, it } from 'vitest';
import {
  grokImageCost,
  grokTextCostFromUsage,
  grokVideoCost,
  grokVideoDurationCost,
  isNativeGrokImageEndpoint,
  nativeGrokImageModel,
  nativeGrokTextModel,
} from './grok-native';

const usage = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

describe('nativeGrokTextModel', () => {
  it('maps our registry ids onto the names xAI serves', () => {
    expect(nativeGrokTextModel('x-ai/grok-4.6')).toBe('grok-4.6');
    expect(nativeGrokTextModel('x-ai/grok-4.20')).toBe(
      'grok-4.20-0309-reasoning'
    );
  });

  it('returns undefined for every non-Grok model', () => {
    expect(nativeGrokTextModel('anthropic/claude-sonnet-5')).toBeUndefined();
    expect(nativeGrokTextModel('openai/gpt-5.5')).toBeUndefined();
  });
});

describe('grokTextCostFromUsage', () => {
  it('prices grok-4.6 at the published per-token rates', () => {
    // 100k prompt @ $2/1M + 100k completion @ $6/1M = $0.80. Both counts sit
    // under the long-context threshold, so these are the base rates.
    expect(grokTextCostFromUsage(usage(100_000, 100_000), 'grok-4.6')).toBe(
      800_000
    );
  });

  it('doubles both rates once the prompt crosses the long-context tier', () => {
    // 199_999 prompt tokens is still the cheap tier; 200_000 is not. Missing
    // this doubles nothing and under-charges every long script analysis — the
    // exact shape of call that crosses it.
    const below = grokTextCostFromUsage(usage(199_999, 0), 'grok-4.6');
    const at = grokTextCostFromUsage(usage(200_000, 0), 'grok-4.6');
    expect(below).toBe(399_998);
    expect(at).toBe(800_000);
  });

  it('returns undefined when the adapter reported no usage at all', () => {
    // Distinct from a $0 charge: the caller reports it as a missing cost
    // rather than silently recording nothing owed.
    expect(grokTextCostFromUsage(undefined, 'grok-4.6')).toBeUndefined();
  });
});

describe('nativeGrokImageModel', () => {
  it('maps registry keys onto the Imagine models xAI serves', () => {
    expect(nativeGrokImageModel('grok_imagine_image')).toBe(
      'grok-imagine-image-2.0'
    );
    expect(nativeGrokImageModel('grok_imagine_image_quality')).toBe(
      'grok-imagine-image-quality'
    );
    expect(nativeGrokImageModel('flux_2_max')).toBeUndefined();
  });

  it('treats both Imagine image endpoints as native', () => {
    expect(isNativeGrokImageEndpoint('grok-imagine-image-2.0')).toBe(true);
    expect(isNativeGrokImageEndpoint('grok-imagine-image-quality')).toBe(true);
    expect(
      isNativeGrokImageEndpoint('xai/grok-imagine-image/v2.0/text-to-image')
    ).toBe(false);
  });
});

describe('grokImageCost', () => {
  it('bills each Imagine image model at its published flat rate', () => {
    expect(grokImageCost(1, 'grok-imagine-image-2.0')).toBe(40_000);
    expect(grokImageCost(4, 'grok-imagine-image-2.0')).toBe(160_000);
    expect(grokImageCost(1, 'grok-imagine-image-quality')).toBe(50_000);
    expect(grokImageCost(4, 'grok-imagine-image-quality')).toBe(200_000);
  });
});

describe('grokVideoCost', () => {
  it('converts xAI’s exact reported charge', () => {
    expect(grokVideoCost(0.4)).toBe(400_000);
  });

  it('returns undefined for a missing or non-finite cost', () => {
    expect(grokVideoCost(undefined)).toBeUndefined();
    expect(grokVideoCost(Number.NaN)).toBeUndefined();
    expect(grokVideoCost(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('grokVideoDurationCost', () => {
  it('matches what xAI actually reports for the same clip', () => {
    // The pre-flight gate and the settled charge should agree, or the gate is
    // approving renders the ledger can't cover.
    expect(grokVideoDurationCost(5)).toBe(grokVideoCost(0.4));
  });
});
