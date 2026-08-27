/**
 * Native-Gemini mapping and pricing. Google reports token counts but no cost,
 * so unlike the OpenRouter path these functions ARE the bill — a wrong figure
 * here is a silent mischarge on every render.
 */

import { describe, expect, it } from 'vitest';
import {
  geminiTextCostFromUsage,
  geminiVideoCostFromUsage,
  geminiVideoDurationCost,
  isNativeGeminiVideoModel,
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
  });

  it('returns undefined for every non-Gemini model', () => {
    expect(nativeGeminiTextModel('anthropic/claude-sonnet-5')).toBeUndefined();
    expect(nativeGeminiTextModel('x-ai/grok-4.6')).toBeUndefined();
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

  it('prices 3 Flash flat — it has no long-context tier', () => {
    // 1M prompt @ $0.25/1M + 1M completion @ $1.50/1M = $1.75 exactly, even
    // though the prompt is far past where Pro's tier would have doubled it.
    expect(
      geminiTextCostFromUsage(
        usage(1_000_000, 1_000_000),
        'gemini-3-flash-preview'
      )
    ).toBe(1_750_000);
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
