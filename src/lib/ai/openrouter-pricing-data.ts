// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-openrouter-pricing.ts

export type OpenRouterPricing = {
  name: string;
  /** USD per 1M input tokens */
  promptPerMillionTokens: number;
  /** USD per 1M output tokens */
  completionPerMillionTokens: number;
  /** USD per web search query, when supported */
  webSearchPerQuery?: number;
};

export const OPENROUTER_PRICING: Record<string, OpenRouterPricing> = {
  'anthropic/claude-fable-5': {
    name: 'Anthropic: Claude Fable 5',
    promptPerMillionTokens: 10,
    completionPerMillionTokens: 50,
    webSearchPerQuery: 0.01,
  },
  'anthropic/claude-opus-5': {
    name: 'Claude Opus 5',
    promptPerMillionTokens: 5,
    completionPerMillionTokens: 25,
    webSearchPerQuery: 0.01,
  },
  'anthropic/claude-opus-5-fast': {
    name: 'Claude Opus 5 (Fast)',
    promptPerMillionTokens: 10,
    completionPerMillionTokens: 50,
    webSearchPerQuery: 0.01,
  },
  'google/gemini-3.7-flash': {
    name: 'Google: Gemini 3.7 Flash',
    promptPerMillionTokens: 0.375,
    completionPerMillionTokens: 1.875,
    webSearchPerQuery: 0.014,
  },
  'google/gemini-3.1-pro-preview': {
    name: 'Google: Gemini 3.1 Pro Preview',
    promptPerMillionTokens: 2,
    completionPerMillionTokens: 12,
    webSearchPerQuery: 0.014,
  },
  'openai/gpt-5.6-sol': {
    name: 'OpenAI: GPT-5.6 Sol',
    promptPerMillionTokens: 2,
    completionPerMillionTokens: 10,
    webSearchPerQuery: 0.01,
  },
  'openai/gpt-5.5': {
    name: 'OpenAI: GPT-5.5',
    promptPerMillionTokens: 5,
    completionPerMillionTokens: 30,
    webSearchPerQuery: 0.01,
  },
  'anthropic/claude-opus-4.8': {
    name: 'Anthropic: Claude Opus 4.8',
    promptPerMillionTokens: 5,
    completionPerMillionTokens: 25,
    webSearchPerQuery: 0.01,
  },
  'x-ai/grok-4.20': {
    name: 'SpaceXAI: Grok 4.20',
    promptPerMillionTokens: 1.25,
    completionPerMillionTokens: 2.5,
    webSearchPerQuery: 0.005,
  },
  'google/gemini-3-flash-preview': {
    name: 'Google: Gemini 3 Flash Preview',
    promptPerMillionTokens: 0.5,
    completionPerMillionTokens: 3,
    webSearchPerQuery: 0.014,
  },
  'z-ai/glm-5.3-flash': {
    name: 'Z.ai: GLM 5.3 Flash',
    promptPerMillionTokens: 0.075,
    completionPerMillionTokens: 0.25,
  },
  'openai/gpt-5.6-terra': {
    name: 'OpenAI: GPT-5.6 Terra',
    promptPerMillionTokens: 2,
    completionPerMillionTokens: 12,
    webSearchPerQuery: 0.01,
  },
  'deepseek/deepseek-v4-pro-0813': {
    name: 'DeepSeek: DeepSeek V4 Pro 0813',
    promptPerMillionTokens: 1.32,
    completionPerMillionTokens: 3.9600000000000004,
  },
  'anthropic/claude-sonnet-5': {
    name: 'Anthropic: Claude Sonnet 5',
    promptPerMillionTokens: 2,
    completionPerMillionTokens: 10,
    webSearchPerQuery: 0.01,
  },
  'x-ai/grok-4.6': {
    name: 'SpaceXAI: Grok 4.6',
    promptPerMillionTokens: 2,
    completionPerMillionTokens: 6,
    webSearchPerQuery: 0.005,
  },
  'openai/gpt-5.6-luna': {
    name: 'OpenAI: GPT-5.6 Luna',
    promptPerMillionTokens: 0.19999999999999998,
    completionPerMillionTokens: 1.2,
    webSearchPerQuery: 0.01,
  },
  'openai/gpt-5.4-mini': {
    name: 'OpenAI: GPT-5.4 Mini',
    promptPerMillionTokens: 0.75,
    completionPerMillionTokens: 4.5,
    webSearchPerQuery: 0.01,
  },
  'deepseek/deepseek-v3.2': {
    name: 'DeepSeek: DeepSeek V3.2',
    promptPerMillionTokens: 0.26,
    completionPerMillionTokens: 0.38,
  },
  'openai/gpt-5.4-nano': {
    name: 'OpenAI: GPT-5.4 Nano',
    promptPerMillionTokens: 0.19999999999999998,
    completionPerMillionTokens: 1.25,
    webSearchPerQuery: 0.01,
  },
  'mistralai/mistral-small-2603': {
    name: 'Mistral: Mistral Small 4',
    promptPerMillionTokens: 0.15,
    completionPerMillionTokens: 0.6,
  },
  'bytedance-seed/seed-2.0-mini': {
    name: 'ByteDance Seed: Seed-2.0-Mini',
    promptPerMillionTokens: 0.09999999999999999,
    completionPerMillionTokens: 0.39999999999999997,
  },
};

export const OPENROUTER_PRICING_LAST_UPDATED = '2026-08-28T06:23:33.816Z';
