/**
 * Registry of AI models available for script analysis.
 * Ordered by qualityRank (1 = best), which follows the LMArena text
 * leaderboard (arena.ai/leaderboard/text, snapshot 2026-08-27; best-scoring
 * variant per model). Re-rank when bumping models. Open-weight models noted
 * with license field.
 */

export const SCRIPT_ANALYSIS_MODELS = [
  {
    id: 'anthropic/claude-fable-5',
    name: 'Claude Fable 5',
    vendor: 'Anthropic',
    license: 'proprietary' as const,
    // Arena 1507.
    qualityRank: 1,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'Most intelligent Anthropic model, new tier above Opus',
  },
  {
    id: 'anthropic/claude-opus-5',
    name: 'Claude Opus 5',
    vendor: 'Anthropic',
    license: 'proprietary' as const,
    // Arena 1492 (opus-5-high).
    qualityRank: 2,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'Frontier reasoning and coding',
  },
  {
    id: 'anthropic/claude-opus-5-fast',
    name: 'Claude Opus 5 Fast',
    vendor: 'Anthropic',
    license: 'proprietary' as const,
    // Not ranked separately — Opus 5 weights, faster output.
    qualityRank: 3,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'Opus 5 low-latency; used for scene-split',
  },
  {
    id: 'google/gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    vendor: 'Google',
    license: 'proprietary' as const,
    // Arena 1490 (gemini-3.7-flash-high).
    qualityRank: 4,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    vision: true,
    description: 'Fast multimodal with 1M context',
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    vendor: 'Google',
    license: 'proprietary' as const,
    // Arena 1487.
    qualityRank: 5,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    vision: true,
    description: 'Frontier multimodal reasoning with 1M context',
  },
  {
    id: 'openai/gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    vendor: 'OpenAI',
    license: 'proprietary' as const,
    // Arena 1482 (gpt-5.6-sol-xhigh).
    qualityRank: 6,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    description:
      'GPT-5.6 flagship: complex reasoning and agentic work, 1M context',
  },
  {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    vendor: 'OpenAI',
    license: 'proprietary' as const,
    // Arena 1482 (gpt-5.5-high).
    qualityRank: 7,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'Latest GPT-5 series with 1M context',
    // Retired 2026-08-28 for GPT-5.6 Sol; kept for sequences that stored it.
    hidden: true,
  },
  {
    id: 'anthropic/claude-opus-4.8',
    name: 'Claude Opus 4.8',
    vendor: 'Anthropic',
    license: 'proprietary' as const,
    // Arena 1481 (opus-4-8-high).
    qualityRank: 8,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'Frontier reasoning and coding',
    hidden: true,
  },
  {
    id: 'x-ai/grok-4.20',
    name: 'Grok 4.20',
    vendor: 'SpaceXAI',
    license: 'proprietary' as const,
    // Arena 1475 (grok-4.20-beta1).
    qualityRank: 9,
    contextWindow: 2_000_000,
    maxOutputTokens: 1_800_000,
    vision: true,
    description: 'Lowest hallucination rate, flagship agentic model',
    hidden: true,
  },
  {
    id: 'google/gemini-3-flash-preview',
    name: 'Gemini 3 Flash',
    vendor: 'Google',
    license: 'proprietary' as const,
    // Arena 1474.
    qualityRank: 10,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    vision: true,
    description: 'Fast multimodal with 1M context',
    // Retired 2026-08-28 for Gemini 3.7 Flash; kept for sequences that stored it.
    hidden: true,
  },
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    vendor: 'Z.ai',
    license: 'open-weight' as const,
    // Arena 1469 ±12 — only 2.4k votes, released 2026-08-26.
    qualityRank: 11,
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    // Replaced GLM-5.2 (#1367): GLM-5.3 proper has no OpenRouter endpoint with
    // `structured_outputs`, so it can't run our schema calls at all. Flash is
    // natively multimodal AND does strict structured outputs (verified live with
    // an image attached), so unlike 5.2 + GLM-4.6V (#942/#944) it takes the
    // vision-conditioned motion path (#929) itself — no DEFAULT_VISION_MODEL
    // fallback.
    vision: true,
    description: 'Native multimodal, 1M context, long-horizon agents',
  },
  {
    id: 'openai/gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    vendor: 'OpenAI',
    license: 'proprietary' as const,
    // Arena 1466 (gpt-5.6-terra-xhigh).
    qualityRank: 12,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'GPT-5.6 mid tier, between Sol and Luna',
  },
  {
    id: 'deepseek/deepseek-v4-pro-0813',
    name: 'DeepSeek V4 Pro',
    vendor: 'DeepSeek',
    license: 'open-weight' as const,
    // Arena 1462 (v4-pro-high).
    qualityRank: 13,
    contextWindow: 1_048_576,
    maxOutputTokens: 943_717,
    // Text-only.
    vision: false,
    description: 'Open-weights frontier reasoning, 1M context',
  },
  {
    id: 'anthropic/claude-sonnet-5',
    name: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    license: 'proprietary' as const,
    // Arena 1461 (sonnet-5-high).
    qualityRank: 14,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'State-of-the-art coding and structured output',
  },
  {
    id: 'x-ai/grok-4.6',
    name: 'Grok 4.6',
    vendor: 'SpaceXAI',
    license: 'proprietary' as const,
    // Arena 1461 ±10 (grok-4.6-high) — only 3.5k votes, released 2026-08-12.
    qualityRank: 15,
    contextWindow: 500_000,
    maxOutputTokens: 450_000,
    // Accepts image input — required so the motion-prompt pass can be
    // conditioned on the rendered starting frame (#929). Conservative: only
    // models known to accept image input are `true`; text-only models fall
    // back to the text-only motion prompt path.
    vision: true,
    description: 'Frontier xAI reasoning model, xAI’s smartest, 500K context',
  },
  {
    id: 'openai/gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    license: 'proprietary' as const,
    // Arena 1452 (gpt-5.6-luna-xhigh).
    qualityRank: 16,
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'GPT-5.6 fast, cost-efficient tier; default analysis model',
  },
  {
    id: 'openai/gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    vendor: 'OpenAI',
    license: 'proprietary' as const,
    // Arena 1448 (gpt-5.4-mini-high).
    qualityRank: 17,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'Fast reasoning with configurable effort modes',
    // Retired 2026-08-28 for GPT-5.6 Terra; kept for sequences that stored it.
    hidden: true,
  },
  {
    id: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek V3.2',
    vendor: 'DeepSeek',
    license: 'open-weight' as const,
    // Arena 1425.
    qualityRank: 18,
    contextWindow: 163_840,
    maxOutputTokens: 147_456,
    // Text-only.
    vision: false,
    description: 'MIT license, MMLU 94.2, GPT-5 class reasoning',
    hidden: true,
  },
  {
    id: 'openai/gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    vendor: 'OpenAI',
    license: 'proprietary' as const,
    // Arena 1402 (gpt-5.4-nano-high).
    qualityRank: 19,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    vision: true,
    description: 'Fastest and most cost-efficient GPT-5.4 variant',
    // Retired 2026-08-28 for GPT-5.6 Luna; kept for sequences that stored it.
    hidden: true,
  },
  {
    id: 'mistralai/mistral-small-2603',
    name: 'Mistral Small 4',
    vendor: 'Mistral',
    license: 'open-weight' as const,
    // Not on the Arena board.
    qualityRank: 20,
    contextWindow: 262_144,
    maxOutputTokens: 209_715,
    vision: true,
    description: 'Apache 2.0, 119B MoE, multimodal + agentic coding',
  },
  {
    id: 'bytedance-seed/seed-2.0-mini',
    name: 'Seed 2.0 Mini',
    vendor: 'ByteDance',
    license: 'proprietary' as const,
    // Not on the Arena board (Seed 2.0 Pro is 1456).
    qualityRank: 21,
    contextWindow: 262_144,
    maxOutputTokens: 131_072,
    vision: true,
    description: 'Fast multimodal with 4 reasoning effort modes',
  },
] as const;

type AnalysisModel = (typeof SCRIPT_ANALYSIS_MODELS)[number];
export type AnalysisModelId = AnalysisModel['id'];

/**
 * Get model by ID
 */
export function getAnalysisModelById(id: string): AnalysisModel | undefined {
  return SCRIPT_ANALYSIS_MODELS.find((model) => model.id === id);
}

/**
 * Runtime validation: Check if a string is a valid AnalysisModelId
 * @param value - String value to validate
 * @returns true if value is a valid model ID, false otherwise
 */
export function isValidAnalysisModelId(
  value: unknown
): value is AnalysisModelId {
  return (
    typeof value === 'string' &&
    SCRIPT_ANALYSIS_MODELS.some((model) => model.id === value)
  );
}

/** Retired ids stay in the registry for old sequences; they are not pickable. */
export function isSelectableAnalysisModelId(
  value: unknown
): value is AnalysisModelId {
  if (!isValidAnalysisModelId(value)) return false;
  const model = getAnalysisModelById(value);
  if (!model) return false;
  return !('hidden' in model && model.hidden);
}

/**
 * Get all model IDs
 */
function getAllModelIds(): AnalysisModelId[] {
  return SCRIPT_ANALYSIS_MODELS.map((model) => model.id);
}

export const ANALYSIS_MODEL_IDS = getAllModelIds();

/**
 * Get context window size (in tokens) for a model
 */
export function getContextWindow(modelId: string): number {
  const model = SCRIPT_ANALYSIS_MODELS.find((m) => m.id === modelId);
  return model?.contextWindow ?? 128_000;
}

/**
 * Conservative output ceiling for an unknown model — below every ceiling in
 * the table, so a model we don't know can never be sent an over-limit budget.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/**
 * The output-token budget to send for a call, as a fraction of the context
 * window but never above what the model can actually emit (#1308).
 *
 * Call sites used to send `getContextWindow(model) * 0.5` as `max_tokens`,
 * which conflates two different limits: half of Opus 5's 1M context is
 * 500,000, but its real completion ceiling is 128,000 — and half of Gemini's
 * 1,048,576 is 8× its 65,536 ceiling. The fraction still expresses "leave
 * room for the input"; the clamp keeps the request legal.
 *
 * Ceilings are `top_provider.max_completion_tokens` from OpenRouter's
 * `/api/v1/models`, the same catalogue that serves the calls.
 */
export function getMaxOutputTokens(modelId: string, fraction = 0.5): number {
  const model = SCRIPT_ANALYSIS_MODELS.find((m) => m.id === modelId);
  const ceiling = model?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const budget = Math.floor(
    (model?.contextWindow ?? 128_000) * Math.min(Math.max(fraction, 0), 1)
  );
  return Math.max(1, Math.min(budget, ceiling));
}

/**
 * Whether an analysis model accepts image input. Used by the motion-prompt
 * pass to decide whether to attach the rendered starting frame as a vision
 * input (#929). Unknown models default to `false` so an image is never sent
 * to a model that can't accept one — the motion prompt simply falls back to
 * the text-only path.
 */
export function analysisModelSupportsVision(modelId: string): boolean {
  return getAnalysisModelById(modelId)?.vision ?? false;
}

/**
 * Vision-capable model that image-bearing calls fall back to when the chosen
 * analysis model is text-only (#944). The motion-prompt pass conditions on the
 * rendered still (#929), so a text model selected for analysis still needs a
 * multimodal model for that one call. Sonnet is the default: it does vision +
 * strict structured outputs + reasoning, which the motion-prompt call requires
 * (GLM-4.6V couldn't — see #942/#944; GLM-5.3 Flash can, so it never falls
 * back here).
 */
export const DEFAULT_VISION_MODEL: AnalysisModelId =
  'anthropic/claude-sonnet-5';

/**
 * Resolve which model should actually run a call given whether it carries image
 * input. A text-only model with image input is swapped to `DEFAULT_VISION_MODEL`
 * so the image can be used; everything else runs as chosen. The effective model
 * drives the adapter, context window, and cost; callers keep storing/hashing the
 * requested model.
 */
export function resolveVisionModel(
  modelId: AnalysisModelId,
  hasImageInput: boolean
): AnalysisModelId {
  if (!hasImageInput || analysisModelSupportsVision(modelId)) return modelId;
  return DEFAULT_VISION_MODEL;
}
/**
 * Default model when none is specified. Luna won the analysis speed/quality
 * eval (pipeline 95.7 at ~$0.015 vs Fable 5 at $0.85) and is the Turbo
 * analysis default. Quality mode selects Fable; both modes show the full
 * picker, grouped Fast / Quality.
 * Existing users keep whatever generation settings already store.
 */
export const DEFAULT_ANALYSIS_MODEL: AnalysisModelId = 'openai/gpt-5.6-luna';

/**
 * Boundary-annotation scenes call only. Grok 4.6 + medium reasoning
 * spends minutes thinking before the first boundary token. Opus 5 Fast
 * split a prose product-ad in 2.4s (9 beats) and a 19-heading screenplay
 * in 4s with exact quotes. Bibles and later prompt calls keep the
 * sequence's analysis model.
 */
export const SCENE_SPLIT_MODEL: AnalysisModelId =
  'anthropic/claude-opus-5-fast';

/**
 * Image generation models are now in src/lib/ai/models.ts
 * Use IMAGE_MODELS, TextToImageModelId, and related helpers from there instead.
 * @deprecated Import from @/lib/ai/models instead
 */
