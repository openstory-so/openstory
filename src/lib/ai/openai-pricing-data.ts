/**
 * OpenAI list prices we bill OpenStory credits against (#1168).
 *
 * Source: https://developers.openai.com/api/docs/pricing (fetched 2026-08-13).
 * GPT Image 2 typical per-image figures come from the official calculator
 * in the image-generation guide (High quality, the quality we send).
 *
 * This file is the pricing record for direct-OpenAI calls — same role
 * `openrouter-pricing-data.ts` plays for OpenRouter `usage.cost` fallback
 * display. There is no public OpenAI pricing API to cron.
 */

export type OpenAiTokenPricing = {
  /** USD per 1M uncached input tokens */
  promptPerMillionTokens: number;
  /** USD per 1M cached input tokens */
  cachedPromptPerMillionTokens: number;
  /** USD per 1M output tokens */
  completionPerMillionTokens: number;
};

export type OpenAiImageTokenPricing = {
  textInputPerMillionTokens: number;
  imageInputPerMillionTokens: number;
  cachedImageInputPerMillionTokens: number;
  outputPerMillionTokens: number;
};

/** Native model id (`gpt-5.5`), not the OpenRouter `openai/gpt-5.5` slug. */
export const OPENAI_TEXT_PRICING: Record<string, OpenAiTokenPricing> = {
  'gpt-5.5': {
    promptPerMillionTokens: 5,
    cachedPromptPerMillionTokens: 0.5,
    completionPerMillionTokens: 30,
  },
  'gpt-5.4-mini': {
    promptPerMillionTokens: 0.75,
    cachedPromptPerMillionTokens: 0.075,
    completionPerMillionTokens: 4.5,
  },
  'gpt-5.4-nano': {
    promptPerMillionTokens: 0.2,
    cachedPromptPerMillionTokens: 0.02,
    completionPerMillionTokens: 1.25,
  },
};

export const OPENAI_IMAGE_TOKEN_PRICING: OpenAiImageTokenPricing = {
  textInputPerMillionTokens: 5,
  imageInputPerMillionTokens: 8,
  cachedImageInputPerMillionTokens: 2,
  outputPerMillionTokens: 30,
};

/**
 * Official High-quality typical costs for the three sizes we send.
 * Used when the Images API does not report token usage.
 */
export const OPENAI_IMAGE_TYPICAL_USD: Record<string, number> = {
  '1024x1024': 0.211,
  '1024x1536': 0.165,
  '1536x1024': 0.165,
};
