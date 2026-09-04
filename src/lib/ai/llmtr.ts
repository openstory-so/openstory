/**
 * LLMTR gateway routing — registry id → LLMTR model name, and pricing.
 *
 * LLMTR (llmtr.com, by Knowhy.co) is a Turkey-hosted, OpenAI-compatible LLM
 * gateway: one key fronts Anthropic / OpenAI / Google / xAI / DeepSeek plus
 * models it hosts in Turkey itself. Its `/v1` wire format and its `/v1/models`
 * payload are OpenRouter-shaped, which is why the OpenRouter adapter drives it
 * with nothing but a `serverURL` swap (see `create-adapter.ts`) — the same
 * trick #895 plays with fal's OpenRouter proxy.
 *
 * Two things this file exists to pin down:
 *
 * 1. **Slug drift.** LLMTR namespaces some vendors differently from
 *    OpenRouter (`xai/` not `x-ai/`, `zai/` not `z-ai/`, `mistral/` not
 *    `mistralai/`). Sending a registry id straight through 404s, so every
 *    routable model is spelled out in {@link LLMTR_TEXT_MODELS}. A registry id
 *    that is absent from that map is NOT routable through LLMTR and resolution
 *    skips the LLMTR key for it (`api-keys.ts`), rather than guessing at a
 *    near-neighbour model the caller never asked for.
 * 2. **Unaudited spend.** LLMTR reports token counts but no per-request
 *    `cost`, so a call billed off `usage.cost` alone would land as $0 (see
 *    `llmCostFromUsage`). {@link LLMTR_TEXT_RATES} carries the catalog rates so
 *    the charge is real. Same shape, same caveat as `grok-native.ts`: this
 *    spend bypasses `model_pricing` and the hourly fal reconcile, so the #1069
 *    drift detection does not cover it.
 *
 * Client-safe: no env access, no adapters.
 */

import type { AnalysisModelId } from '@/lib/ai/models.config';
import { usdToMicros, type Microdollars } from '@/lib/billing/money';
import { typedEntries } from '@/lib/utils/typed-object';
import type { TokenUsage } from '@tanstack/ai';

/** LLMTR's OpenAI-compatible base URL. */
export const LLMTR_BASE_URL = 'https://llmtr.com/v1';

/**
 * Registry ids LLMTR does not carry. Absence is a routing decision, not an
 * alias: substituting a neighbour would silently change the model the caller
 * asked for. A new `AnalysisModelId` that is in neither this list nor
 * {@link LLMTR_TEXT_MODELS} is a compile error.
 *
 * Re-check against https://llmtr.com/v1/models when the registry changes.
 */
export const LLMTR_UNMAPPED_MODEL_IDS = [
  'anthropic/claude-opus-5-fast',
  'deepseek/deepseek-v3.2',
  'bytedance-seed/seed-2.0-mini',
] as const satisfies ReadonlyArray<AnalysisModelId>;

type LlmtrMappedId = Exclude<
  AnalysisModelId,
  (typeof LLMTR_UNMAPPED_MODEL_IDS)[number]
>;

/**
 * Registry id → LLMTR catalog id, for every text model LLMTR carries.
 *
 * Only genuine equivalences: `x-ai/grok-4.20` picks `-0309-reasoning` for the
 * same reason `grok-native.ts` does (OpenRouter fronts the reasoning build, so
 * that build is what the id means), and `mistral/mistral-small-latest` is
 * LLMTR's spelling of the release OpenRouter pins as `mistral-small-2603`
 * ("Mistral Small 4" on both sides).
 */
export const LLMTR_TEXT_MODELS = {
  'anthropic/claude-fable-5': 'anthropic/claude-fable-5',
  'anthropic/claude-opus-5': 'anthropic/claude-opus-5',
  'google/gemini-3.7-flash': 'google/gemini-3.7-flash',
  'google/gemini-3.1-pro-preview': 'google/gemini-3.1-pro-preview',
  'openai/gpt-5.6-sol': 'openai/gpt-5.6-sol',
  'openai/gpt-5.5': 'openai/gpt-5.5',
  'anthropic/claude-opus-4.8': 'anthropic/claude-opus-4.8',
  'x-ai/grok-4.20': 'xai/grok-4.20-0309-reasoning',
  'google/gemini-3-flash-preview': 'google/gemini-3-flash-preview',
  'z-ai/glm-5.3-flash': 'zai/glm-5.3-flash',
  'openai/gpt-5.6-terra': 'openai/gpt-5.6-terra',
  'deepseek/deepseek-v4-pro-0813': 'deepseek/deepseek-v4-pro-0813',
  'anthropic/claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'x-ai/grok-4.6': 'xai/grok-4.6',
  'openai/gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'openai/gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano': 'openai/gpt-5.4-nano',
  'mistralai/mistral-small-2603': 'mistral/mistral-small-latest',
} as const satisfies Record<LlmtrMappedId, string>;

export type LlmtrTextModel =
  (typeof LLMTR_TEXT_MODELS)[keyof typeof LLMTR_TEXT_MODELS];

const LLMTR_TEXT_MODEL_BY_ID = new Map<string, LlmtrTextModel>(
  typedEntries(LLMTR_TEXT_MODELS)
);

/**
 * The LLMTR catalog id for a registry model, or undefined when LLMTR can't
 * serve it. Undefined is a routing decision, not an error: key resolution
 * skips LLMTR and the call goes to OpenRouter/fal as before.
 */
export function llmtrTextModel(model: string): LlmtrTextModel | undefined {
  return LLMTR_TEXT_MODEL_BY_ID.get(model);
}

/**
 * The LLMTR catalog ids that are NOT valid OpenRouter slugs. The
 * OpenRouter adapter's generated model union rejects them, so
 * `create-adapter.ts` widens the factory with exactly these — the identity
 * mappings above already typecheck.
 */
export const LLMTR_ONLY_MODEL_IDS = [
  'mistral/mistral-small-latest',
  'xai/grok-4.6',
  'xai/grok-4.20-0309-reasoning',
  'zai/glm-5.3-flash',
] as const satisfies ReadonlyArray<LlmtrTextModel>;

/**
 * A `$0`, 1-token completion is the only way to prove a key: LLMTR's
 * `/v1/models` is public and answers 200 for a bogus key, so it can't
 * validate anything. Free tier, so the check costs nothing.
 */
export const LLMTR_VALIDATION_MODEL = 'qwen/qwen3.6-27b-free';

/**
 * LLMTR catalog rates in USD per 1M tokens (read from
 * https://llmtr.com/v1/models on 2026-09-04 — `pricing.prompt` /
 * `pricing.completion`, which are per-token, ×1e6).
 *
 * Transcribed provider rates, not estimates: LLMTR returns token counts with
 * no `cost` field, so without this table an LLMTR call bills $0. They are NOT
 * bill-verified the way fal rates are (#1069); re-read the catalog when a
 * model is added or a vendor re-prices.
 */
const LLMTR_TEXT_RATES: Record<
  LlmtrTextModel,
  { input: number; output: number }
> = {
  'anthropic/claude-fable-5': { input: 10, output: 50 },
  'anthropic/claude-opus-5': { input: 5, output: 25 },
  'google/gemini-3.7-flash': { input: 0.75, output: 3.75 },
  'google/gemini-3.1-pro-preview': { input: 2, output: 12 },
  'openai/gpt-5.6-sol': { input: 4, output: 20 },
  'openai/gpt-5.5': { input: 5, output: 30 },
  'anthropic/claude-opus-4.8': { input: 5, output: 25 },
  'xai/grok-4.20-0309-reasoning': { input: 1.25, output: 2.5 },
  'google/gemini-3-flash-preview': { input: 0.5, output: 3 },
  'zai/glm-5.3-flash': { input: 0.075, output: 0.25 },
  'openai/gpt-5.6-terra': { input: 2, output: 12 },
  'deepseek/deepseek-v4-pro-0813': { input: 1.32, output: 3.96 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'xai/grok-4.6': { input: 2, output: 6 },
  'openai/gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'openai/gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'mistral/mistral-small-latest': { input: 0.15, output: 0.6 },
};

/**
 * Price a completed LLMTR call from its token counts.
 *
 * Undefined when the adapter reported no usage, or when the model isn't one
 * LLMTR serves — the caller reports that as a missing cost rather than
 * inventing a rate.
 */
export function llmtrTextCostFromUsage(
  usage: TokenUsage | undefined,
  model: string
): Microdollars | undefined {
  if (!usage) return undefined;

  const llmtrModel = llmtrTextModel(model);
  if (!llmtrModel) return undefined;

  const rates = LLMTR_TEXT_RATES[llmtrModel];
  const usd =
    (usage.promptTokens / 1_000_000) * rates.input +
    (usage.completionTokens / 1_000_000) * rates.output;
  return usdToMicros(usd);
}
