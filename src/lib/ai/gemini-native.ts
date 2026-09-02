/**
 * Native Google (Gemini) routing — registry id → Gemini model name, and
 * pricing. The Google analogue of `grok-native.ts` (#1167's pattern): Gemini
 * models go to `generativelanguage.googleapis.com` when a Google key
 * resolves, and fall back to OpenRouter/fal unchanged when none does.
 *
 * Client-safe: no env access, no adapters.
 */

import type { ImageToVideoModel, TextToImageModel } from '@/lib/ai/models';
import type { AnalysisModelId } from '@/lib/ai/models.config';
import { usdToMicros, type Microdollars } from '@/lib/billing/money';
import { typedEntries } from '@/lib/utils/typed-object';
import type { TokenUsage } from '@tanstack/ai';

const NATIVE_TEXT_MODELS = {
  'google/gemini-3.7-flash': 'gemini-3.7-flash',
  'google/gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'google/gemini-3-flash-preview': 'gemini-3-flash-preview',
} as const satisfies Partial<Record<AnalysisModelId, string>>;

export type NativeGeminiTextModel =
  (typeof NATIVE_TEXT_MODELS)[keyof typeof NATIVE_TEXT_MODELS];

const NATIVE_TEXT_MODEL_BY_ID = new Map<string, NativeGeminiTextModel>(
  typedEntries(NATIVE_TEXT_MODELS)
);

export function nativeGeminiTextModel(
  model: string
): NativeGeminiTextModel | undefined {
  return NATIVE_TEXT_MODEL_BY_ID.get(model);
}

/**
 * Gemini Omni Flash on Google's Interactions API. One model name covers
 * image-to-video AND reference-to-video — the task is inferred from the
 * content (or pinned via `generation_config.video_config.task`), unlike fal
 * where each task is its own endpoint.
 */
export const NATIVE_GEMINI_VIDEO_MODEL = 'gemini-omni-1.1-flash';

export function isNativeGeminiVideoModel(model: ImageToVideoModel): boolean {
  return model === 'gemini_omni_flash';
}

/**
 * Registry key → Gemini native image model. Fal ids in `IMAGE_MODELS` stay
 * the no-key fallback; native generateContent uses these GA names.
 *
 * @see https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image
 * @see https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite-image
 * @see https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image
 */
const NATIVE_IMAGE_MODELS = {
  nano_banana_2: 'gemini-3.1-flash-image',
  nano_banana_2_lite: 'gemini-3.1-flash-lite-image',
  nano_banana_pro: 'gemini-3-pro-image',
} as const satisfies Partial<Record<TextToImageModel, string>>;

export type NativeGeminiImageModel =
  (typeof NATIVE_IMAGE_MODELS)[keyof typeof NATIVE_IMAGE_MODELS];

const NATIVE_IMAGE_MODEL_BY_KEY = new Map<string, NativeGeminiImageModel>(
  typedEntries(NATIVE_IMAGE_MODELS)
);

const NATIVE_IMAGE_ENDPOINT_IDS = new Set<string>(
  Object.values(NATIVE_IMAGE_MODELS)
);

export function nativeGeminiImageModel(
  model: TextToImageModel
): NativeGeminiImageModel | undefined {
  return NATIVE_IMAGE_MODEL_BY_KEY.get(model);
}

export function isNativeGeminiImageModel(model: TextToImageModel): boolean {
  return NATIVE_IMAGE_MODEL_BY_KEY.has(model);
}

/** True when this endpoint id is a Gemini native image model, not a fal id. */
export function isNativeGeminiImageEndpoint(endpointId: string): boolean {
  return NATIVE_IMAGE_ENDPOINT_IDS.has(endpointId);
}

/**
 * Published Google rates (ai.google.dev/gemini-api/docs/pricing, read
 * 2026-08-27). Transcribed provider rates, not estimates: the Gemini adapter
 * reports token counts but no cost, so without these a native call bills $0.
 *
 * `highTierFrom` is the prompt-token count at which Google's long-context
 * tier kicks in (3.1 Pro only — Flash has a single tier, expressed here as
 * identical rates with an unreachable threshold).
 */
const TEXT_RATES: Record<
  NativeGeminiTextModel,
  {
    input: number;
    output: number;
    inputHigh: number;
    outputHigh: number;
    highTierFrom: number;
  }
> = {
  'gemini-3.1-pro-preview': {
    input: 2,
    output: 12,
    inputHigh: 4,
    outputHigh: 18,
    highTierFrom: 200_000,
  },
  'gemini-3-flash-preview': {
    input: 0.5,
    output: 3,
    inputHigh: 0.5,
    outputHigh: 3,
    highTierFrom: Number.POSITIVE_INFINITY,
  },
  // Introductory rate; Google lists $1.50/$7.50 from 2027-01-01. The
  // model-freshness routine (or whoever lands past the expiry) bumps this.
  'gemini-3.7-flash': {
    input: 0.75,
    output: 3.75,
    inputHigh: 0.75,
    outputHigh: 3.75,
    highTierFrom: Number.POSITIVE_INFINITY,
  },
};

/**
 * Omni Flash bills video output as tokens: a fixed 5,792 tokens per second of
 * 720p video at the video-output rate of $17.50 per 1M tokens (≈$0.101/s).
 * The adapter surfaces those output tokens as `usage.completionTokens`.
 */
const OMNI_VIDEO_TOKENS_PER_SECOND = 5_792;
const OMNI_VIDEO_USD_PER_1M_TOKENS = 17.5;

/** Undefined when the adapter reported no usage — the caller reports that as a
 *  missing cost rather than inventing one. */
export function geminiTextCostFromUsage(
  usage: TokenUsage | undefined,
  model: NativeGeminiTextModel
): Microdollars | undefined {
  if (!usage) return undefined;

  const rates = TEXT_RATES[model];
  const longContext = usage.promptTokens >= rates.highTierFrom;
  const inputRate = longContext ? rates.inputHigh : rates.input;
  const outputRate = longContext ? rates.outputHigh : rates.output;

  const usd =
    (usage.promptTokens / 1_000_000) * inputRate +
    (usage.completionTokens / 1_000_000) * outputRate;
  return usdToMicros(usd);
}

/**
 * Settled charge for an Omni Flash video, from the interaction's reported
 * output tokens. Undefined when the adapter reported no usage (or zero output
 * tokens — a completed video always bills some), so the caller reports a
 * missing cost instead of recording $0 owed.
 */
export function geminiVideoCostFromUsage(
  usage: TokenUsage | undefined
): Microdollars | undefined {
  if (!usage || !Number.isFinite(usage.completionTokens)) return undefined;
  if (usage.completionTokens <= 0) return undefined;
  return usdToMicros(
    (usage.completionTokens / 1_000_000) * OMNI_VIDEO_USD_PER_1M_TOKENS
  );
}

/**
 * Published per-image equivalents (ai.google.dev/gemini-api/docs/pricing,
 * read 2026-09-02). Google bills image output as tokens; these ARE the
 * advertised 1K/2K/4K conversions, not bill-verified. Lite is 1K-only so
 * every tier maps to the 1K rate. Native spend is unaudited by #1069.
 */
const IMAGE_USD_PER_IMAGE: Record<
  NativeGeminiImageModel,
  Record<'1K' | '2K' | '4K', number>
> = {
  'gemini-3.1-flash-image': { '1K': 0.067, '2K': 0.101, '4K': 0.151 },
  'gemini-3.1-flash-lite-image': { '1K': 0.0336, '2K': 0.0336, '4K': 0.0336 },
  'gemini-3-pro-image': { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
};

export type GeminiImageResolution = '1K' | '2K' | '4K';

/** Exact advertised rate for the images returned, at the requested tier. */
export function geminiImageCost(
  numImages: number,
  model: NativeGeminiImageModel,
  resolution: GeminiImageResolution = '1K'
): Microdollars {
  return usdToMicros(numImages * IMAGE_USD_PER_IMAGE[model][resolution]);
}

/** Pre-flight estimate; the charge that lands comes from
 *  {@link geminiVideoCostFromUsage}. */
export function geminiVideoDurationCost(seconds: number): Microdollars {
  return usdToMicros(
    ((seconds * OMNI_VIDEO_TOKENS_PER_SECOND) / 1_000_000) *
      OMNI_VIDEO_USD_PER_1M_TOKENS
  );
}
