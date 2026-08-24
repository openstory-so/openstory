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
 * Registry id → LLMTR catalog id, for every text model LLMTR carries.
 *
 * Only genuine equivalences: `x-ai/grok-4.20` picks `-0309-reasoning` for the
 * same reason `grok-native.ts` does (OpenRouter fronts the reasoning build, so
 * that build is what the id means), and `mistral/mistral-small-latest` is
 * LLMTR's spelling of the release OpenRouter pins as `mistral-small-2603`
 * ("Mistral Small 4" on both sides).
 *
 * Deliberately absent — LLMTR carries no equivalent, so these stay on
 * OpenRouter/fal even for an LLMTR-keyed team:
 *   - `anthropic/claude-opus-5-fast` (no `:fast` build in the catalog; plain
 *     Opus 5 is a different latency/price product, not a substitute)
 *   - `deepseek/deepseek-v3.2` (catalog jumps v4-flash → v4-pro)
 *   - `bytedance-seed/seed-2.0-mini` (vendor not carried)
 * Re-check against https://llmtr.com/v1/models when the registry changes.
 */
export const LLMTR_TEXT_MODELS = {
  'anthropic/claude-opus-5': 'anthropic/claude-opus-5',
  'anthropic/claude-fable-5': 'anthropic/claude-fable-5',
  'anthropic/claude-sonnet-5': 'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4.8': 'anthropic/claude-opus-4.8',
  'deepseek/deepseek-v4-pro-0813': 'deepseek/deepseek-v4-pro-0813',
  'google/gemini-3.1-pro-preview': 'google/gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview': 'google/gemini-3-flash-preview',
  'openai/gpt-5.5': 'openai/gpt-5.5',
  'openai/gpt-5.4-mini': 'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano': 'openai/gpt-5.4-nano',
  'mistralai/mistral-small-2603': 'mistral/mistral-small-latest',
  'x-ai/grok-4.6': 'xai/grok-4.6',
  'x-ai/grok-4.20': 'xai/grok-4.20-0309-reasoning',
  'z-ai/glm-5.2': 'zai/glm-5.2',
} as const satisfies Partial<Record<AnalysisModelId, string>>;

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
 * The four LLMTR catalog ids that are NOT valid OpenRouter slugs. The
 * OpenRouter adapter's generated model union rejects them, so
 * `create-adapter.ts` widens the factory with exactly these — the identity
 * mappings above already typecheck.
 */
export const LLMTR_ONLY_MODEL_IDS = [
  'mistral/mistral-small-latest',
  'xai/grok-4.6',
  'xai/grok-4.20-0309-reasoning',
  'zai/glm-5.2',
] as const satisfies ReadonlyArray<LlmtrTextModel>;

/**
 * A `$0`, 1-token completion is the only way to prove a key: LLMTR's
 * `/v1/models` is public and answers 200 for a bogus key, so it can't
 * validate anything. Free tier, so the check costs nothing.
 */
export const LLMTR_VALIDATION_MODEL = 'qwen/qwen3.6-27b-free';

/**
 * LLMTR catalog rates in USD per 1M tokens (read from
 * https://llmtr.com/v1/models on 2026-08-24 — `pricing.prompt` /
 * `pricing.completion`, which are per-token, ×1e6).
 *
 * Transcribed provider rates, not estimates: LLMTR returns token counts with
 * no `cost` field, so without this table an LLMTR call bills $0. LLMTR
 * advertises catalog rates with no per-model markup (its 8% margin is taken on
 * credit top-ups instead), so these track the upstream list prices — which
 * currently match OPENROUTER_PRICING for every shared model. They are NOT
 * bill-verified the way fal rates are (#1069); re-read the catalog when a
 * model is added or a vendor re-prices.
 */
const LLMTR_TEXT_RATES: Record<
  LlmtrTextModel,
  { input: number; output: number }
> = {
  'anthropic/claude-opus-5': { input: 5, output: 25 },
  'anthropic/claude-fable-5': { input: 10, output: 50 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'anthropic/claude-opus-4.8': { input: 5, output: 25 },
  'deepseek/deepseek-v4-pro-0813': { input: 1.32, output: 3.96 },
  'google/gemini-3.1-pro-preview': { input: 2, output: 12 },
  'google/gemini-3-flash-preview': { input: 0.5, output: 3 },
  'openai/gpt-5.5': { input: 5, output: 30 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'openai/gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'mistral/mistral-small-latest': { input: 0.15, output: 0.6 },
  'xai/grok-4.6': { input: 2, output: 6 },
  'xai/grok-4.20-0309-reasoning': { input: 1.25, output: 2.5 },
  'zai/glm-5.2': { input: 1.26, output: 3.96 },
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
