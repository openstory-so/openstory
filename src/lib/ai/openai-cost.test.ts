import { describe, expect, it, vi } from 'vitest';
import { usdToMicros, ZERO_MICROS } from '@/lib/billing/money';

vi.doMock('@/lib/billing/billing-observability', () => ({
  reportMissingBillingCost: vi.fn(),
}));

const { openAiImageCostFromUsage, openAiTextCostFromUsage } =
  await import('./openai-cost');

describe('openAiTextCostFromUsage', () => {
  it('prices uncached input + output at list rates', () => {
    // gpt-5.5: $5 / M in, $30 / M out
    expect(
      openAiTextCostFromUsage(
        {
          promptTokens: 1_000_000,
          completionTokens: 1_000_000,
          totalTokens: 2_000_000,
        },
        'openai/gpt-5.5'
      )
    ).toBe(usdToMicros(35));
  });

  it('applies the cached input rate', () => {
    expect(
      openAiTextCostFromUsage(
        {
          promptTokens: 1_000_000,
          completionTokens: 0,
          totalTokens: 1_000_000,
          promptTokensDetails: { cachedTokens: 400_000 },
        },
        'gpt-5.4-mini'
      )
    ).toBe(usdToMicros(0.6 * 0.75 + 0.4 * 0.075));
  });

  it('returns $0 for an unknown model', () => {
    expect(
      openAiTextCostFromUsage(
        { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        'gpt-unknown'
      )
    ).toBe(ZERO_MICROS);
  });
});

describe('openAiImageCostFromUsage', () => {
  it('falls back to the official High typical when usage is missing', () => {
    expect(
      openAiImageCostFromUsage(undefined, { size: '1024x1024', numImages: 1 })
    ).toBe(usdToMicros(0.211));
    expect(
      openAiImageCostFromUsage(undefined, { size: '1536x1024', numImages: 2 })
    ).toBe(usdToMicros(0.33));
  });

  it('uses token rates when usage is present', () => {
    // 1M image output tokens × $30 = $30
    expect(
      openAiImageCostFromUsage(
        {
          promptTokens: 0,
          completionTokens: 1_000_000,
          totalTokens: 1_000_000,
        },
        { size: '1024x1024', numImages: 1 }
      )
    ).toBe(usdToMicros(30));
  });
});
