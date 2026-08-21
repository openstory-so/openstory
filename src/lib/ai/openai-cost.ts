/**
 * OpenStory credit amounts for direct-OpenAI calls (#1168).
 *
 * Always list-price — even when the team BYOK paid OpenAI. Missing token
 * counts fall back to the official typical table (images) or $0 + a
 * missing-cost report (text).
 */

import {
  OPENAI_IMAGE_TOKEN_PRICING,
  OPENAI_IMAGE_TYPICAL_USD,
  OPENAI_TEXT_PRICING,
} from '@/lib/ai/openai-pricing-data';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import {
  usdToMicros,
  ZERO_MICROS,
  type Microdollars,
} from '@/lib/billing/money';
import type { TokenUsage } from '@tanstack/ai';

function tokensToUsd(tokens: number, perMillion: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens / 1_000_000) * perMillion;
}

/**
 * Native OpenAI model id (`gpt-5.5`) or registry id (`openai/gpt-5.5`).
 */
function openAiNativeId(modelId: string): string {
  return modelId.startsWith('openai/')
    ? modelId.slice('openai/'.length)
    : modelId;
}

export function openAiTextCostFromUsage(
  usage: TokenUsage | undefined,
  modelId: string
): Microdollars {
  const pricing = OPENAI_TEXT_PRICING[openAiNativeId(modelId)];
  if (!pricing) {
    reportMissingBillingCost({
      source: 'openai-text-cost',
      modelId,
      metadata: { usage, reason: 'unknown-model' },
    });
    return ZERO_MICROS;
  }
  if (!usage) {
    reportMissingBillingCost({
      source: 'openai-text-cost',
      modelId,
      metadata: { reason: 'missing-usage' },
    });
    return ZERO_MICROS;
  }

  const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
  const uncached = Math.max(0, usage.promptTokens - cached);
  const usd =
    tokensToUsd(uncached, pricing.promptPerMillionTokens) +
    tokensToUsd(cached, pricing.cachedPromptPerMillionTokens) +
    tokensToUsd(usage.completionTokens, pricing.completionPerMillionTokens);
  return usdToMicros(usd);
}

export function openAiImageCostFromUsage(
  usage: TokenUsage | undefined,
  opts: { size: string; numImages: number }
): Microdollars {
  if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
    const textTokens = usage.promptTokensDetails?.textTokens ?? 0;
    const imageTokens = usage.promptTokensDetails?.imageTokens ?? 0;
    const pricedPrompt =
      textTokens + imageTokens > 0
        ? tokensToUsd(
            textTokens,
            OPENAI_IMAGE_TOKEN_PRICING.textInputPerMillionTokens
          ) +
          tokensToUsd(
            imageTokens,
            OPENAI_IMAGE_TOKEN_PRICING.imageInputPerMillionTokens
          )
        : tokensToUsd(
            usage.promptTokens,
            OPENAI_IMAGE_TOKEN_PRICING.textInputPerMillionTokens
          );
    const usd =
      pricedPrompt +
      tokensToUsd(
        usage.completionTokens,
        OPENAI_IMAGE_TOKEN_PRICING.outputPerMillionTokens
      );
    return usdToMicros(usd);
  }

  const typical = OPENAI_IMAGE_TYPICAL_USD[opts.size];
  if (typical == null) {
    reportMissingBillingCost({
      source: 'openai-image-cost',
      modelId: 'gpt-image-2',
      metadata: { size: opts.size, usage },
    });
    return ZERO_MICROS;
  }
  const count = Math.max(1, opts.numImages);
  return usdToMicros(typical * count);
}
