/**
 * Native-Gemini mapping and pricing. Google reports token counts but no cost,
 * so unlike the OpenRouter path these functions ARE the bill — a wrong figure
 * here is a silent mischarge on every render.
 */

import { describe, expect, it } from 'vitest';
import {
  geminiImageCost,
  geminiTextCostFromUsage,
  geminiVideoCostFromUsage,
  geminiVideoDurationCost,
  isNativeGeminiImageEndpoint,
  isNativeGeminiImageModel,
  isNativeGeminiVideoModel,
  nativeGeminiImageModel,
  nativeGeminiTextModel,
} from './gemini-native';

const usage = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

describe('nativeGeminiTextModel', () => {
  it('maps our registry ids onto the names Google serves', () => {
    expect(nativeGeminiTextModel('google/gemini-3.1-pro-preview')).toBe(
      'gemini-3.1-pro-preview'
    );
    expect(nativeGeminiTextModel('google/gemini-3-flash-preview')).toBe(
      'gemini-3-flash-preview'
    );
    expect(nativeGeminiTextModel('google/gemini-3.7-flash')).toBe(
      'gemini-3.7-flash'
    );
  });

  it('returns undefined for every non-Gemini model', () => {
    expect(nativeGeminiTextModel('anthropic/claude-sonnet-5')).toBeUndefined();
    expect(nativeGeminiTextModel('x-ai/grok-4.6')).toBeUndefined();
  });
});

describe('nativeGeminiImageModel', () => {
  it('maps Nano Banana registry keys onto the GA Gemini image ids', () => {
    expect(nativeGeminiImageModel('nano_banana_2')).toBe(
      'gemini-3.1-flash-image'
    );
    expect(nativeGeminiImageModel('nano_banana_2_lite')).toBe(
      'gemini-3.1-flash-lite-image'
    );
    expect(nativeGeminiImageModel('nano_banana_pro')).toBe(
      'gemini-3-pro-image'
    );
    expect(nativeGeminiImageModel('flux_2_max')).toBeUndefined();
  });

  it('treats the native ids as Gemini endpoints, not fal ids', () => {
    expect(isNativeGeminiImageModel('nano_banana_2_lite')).toBe(true);
    expect(isNativeGeminiImageEndpoint('gemini-3.1-flash-lite-image')).toBe(
      true
    );
    expect(isNativeGeminiImageEndpoint('google/nano-banana-2-lite')).toBe(
      false
    );
  });
});

describe('geminiImageCost', () => {
  it('bills each Nano Banana at its published per-image equivalent', () => {
    expect(geminiImageCost(1, 'gemini-3.1-flash-lite-image', '1K')).toBe(
      33_600
    );
    expect(geminiImageCost(1, 'gemini-3.1-flash-image', '1K')).toBe(67_000);
    expect(geminiImageCost(1, 'gemini-3.1-flash-image', '2K')).toBe(101_000);
    expect(geminiImageCost(1, 'gemini-3-pro-image', '1K')).toBe(134_000);
    expect(geminiImageCost(1, 'gemini-3-pro-image', '4K')).toBe(240_000);
    expect(geminiImageCost(4, 'gemini-3.1-flash-lite-image', '1K')).toBe(
      134_400
    );
  });
});

describe('isNativeGeminiVideoModel', () => {
  it('claims only the Omni Flash registry key', () => {
    expect(isNativeGeminiVideoModel('gemini_omni_flash')).toBe(true);
    expect(isNativeGeminiVideoModel('veo3_1')).toBe(false);
    expect(isNativeGeminiVideoModel('grok_imagine_video_1_5')).toBe(false);
  });
});

describe('geminiTextCostFromUsage', () => {
  it('prices 3.1 Pro at the published per-token rates', () => {
    // 100k prompt @ $2/1M + 100k completion @ $12/1M = $1.40. Both counts sit
    // under the long-context threshold, so these are the base rates.
    expect(
      geminiTextCostFromUsage(usage(100_000, 100_000), 'gemini-3.1-pro-preview')
    ).toBe(1_400_000);
  });

  it('doubles-ish both 3.1 Pro rates once the prompt crosses 200K', () => {
    // 199_999 prompt tokens is still the cheap tier; 200_000 is not ($4/$18).
    const below = geminiTextCostFromUsage(
      usage(199_999, 0),
      'gemini-3.1-pro-preview'
    );
    const at = geminiTextCostFromUsage(
      usage(200_000, 0),
      'gemini-3.1-pro-preview'
    );
    expect(below).toBe(399_998);
    expect(at).toBe(800_000);
  });

  it('prices 3 Flash at the published Standard list — it has no long-context tier', () => {
    // 1M prompt @ $0.50/1M + 1M completion @ $3.00/1M = $3.50 exactly, even
    // though the prompt is far past where Pro's tier would have doubled it.
    expect(
      geminiTextCostFromUsage(
        usage(1_000_000, 1_000_000),
        'gemini-3-flash-preview'
      )
    ).toBe(3_500_000);
  });

  it('returns undefined when the adapter reported no usage at all', () => {
    expect(
      geminiTextCostFromUsage(undefined, 'gemini-3.1-pro-preview')
    ).toBeUndefined();
  });
});

describe('geminiVideoCostFromUsage', () => {
  it('prices the interaction’s video-output tokens at $17.50/1M', () => {
    // A 10-second 720p clip: 57,920 output tokens → $1.0136.
    expect(geminiVideoCostFromUsage(usage(120, 57_920))).toBe(1_013_600);
  });

  it('returns undefined for missing usage or zero output tokens', () => {
    // Distinct from a $0 charge: a completed video always bills some output
    // tokens, so nothing reported means the cost is missing, not zero.
    expect(geminiVideoCostFromUsage(undefined)).toBeUndefined();
    expect(geminiVideoCostFromUsage(usage(120, 0))).toBeUndefined();
  });
});

describe('geminiVideoDurationCost', () => {
  it('matches what Google actually bills for the same clip', () => {
    // The pre-flight gate and the settled charge should agree, or the gate is
    // approving renders the ledger can't cover: 5,792 tokens per second.
    expect(geminiVideoDurationCost(10)).toBe(
      geminiVideoCostFromUsage(usage(0, 57_920))
    );
  });
});
