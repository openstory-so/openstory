/**
 * Native xAI (Grok) routing — registry id → xAI model name, and pricing.
 *
 * Client-safe: no env access, no adapters.
 */

import type { ImageToVideoModel, TextToImageModel } from '@/lib/ai/models';
import type { AnalysisModelId } from '@/lib/ai/models.config';
import { usdToMicros, type Microdollars } from '@/lib/billing/money';
import { typedEntries } from '@/lib/utils/typed-object';
import type { TokenUsage } from '@tanstack/ai';

// `x-ai/grok-4.20` has no single native equivalent — xAI splits it into
// `-0309-reasoning`, `-0309-non-reasoning`, and `-multi-agent-0309`. OpenRouter
// fronts the reasoning build, so that's what keeps the id's meaning.
const NATIVE_TEXT_MODELS = {
  'x-ai/grok-4.6': 'grok-4.6',
  'x-ai/grok-4.20': 'grok-4.20-0309-reasoning',
} as const satisfies Partial<Record<AnalysisModelId, string>>;

export type NativeGrokTextModel =
  (typeof NATIVE_TEXT_MODELS)[keyof typeof NATIVE_TEXT_MODELS];

const NATIVE_TEXT_MODEL_BY_ID = new Map<string, NativeGrokTextModel>(
  typedEntries(NATIVE_TEXT_MODELS)
);

export function nativeGrokTextModel(
  model: string
): NativeGrokTextModel | undefined {
  return NATIVE_TEXT_MODEL_BY_ID.get(model);
}

/** Registry key → xAI Imagine image model. Fal ids in `IMAGE_MODELS` match. */
const NATIVE_IMAGE_MODELS = {
  grok_imagine_image: 'grok-imagine-image-2.0',
  grok_imagine_image_quality: 'grok-imagine-image-quality',
} as const;

export type NativeGrokImageModel =
  (typeof NATIVE_IMAGE_MODELS)[keyof typeof NATIVE_IMAGE_MODELS];

const NATIVE_IMAGE_MODEL_BY_KEY = new Map<string, NativeGrokImageModel>(
  typedEntries(NATIVE_IMAGE_MODELS)
);

const NATIVE_IMAGE_ENDPOINT_IDS = new Set<string>(
  Object.values(NATIVE_IMAGE_MODELS)
);

export const NATIVE_GROK_VIDEO_MODEL = 'grok-imagine-video-1.5';

export function nativeGrokImageModel(
  model: TextToImageModel
): NativeGrokImageModel | undefined {
  return NATIVE_IMAGE_MODEL_BY_KEY.get(model);
}

export function isNativeGrokImageModel(model: TextToImageModel): boolean {
  return NATIVE_IMAGE_MODEL_BY_KEY.has(model);
}

/** True when this endpoint id is an xAI Imagine image model, not a fal id. */
export function isNativeGrokImageEndpoint(endpointId: string): boolean {
  return NATIVE_IMAGE_ENDPOINT_IDS.has(endpointId);
}

export function isNativeGrokVideoModel(model: ImageToVideoModel): boolean {
  return model === 'grok_imagine_video_1_5';
}

/**
 * Published xAI rates (docs.x.ai/developers/models, read 2026-08-21).
 * Transcribed provider rates, not estimates: the adapter reports token
 * counts for chat and images but no cost, so without these a native call
 * bills $0. Video never uses this table — xAI returns the exact charge
 * (see {@link grokVideoCost}).
 *
 * `highTierFrom` is the prompt-token count at which xAI's long-context tier
 * kicks in and both rates double.
 */
const TEXT_RATES: Record<
  NativeGrokTextModel,
  {
    input: number;
    output: number;
    inputHigh: number;
    outputHigh: number;
    highTierFrom: number;
  }
> = {
  'grok-4.6': {
    input: 2,
    output: 6,
    inputHigh: 4,
    outputHigh: 12,
    highTierFrom: 200_000,
  },
  'grok-4.20-0309-reasoning': {
    input: 1.25,
    output: 2.5,
    inputHigh: 2.5,
    outputHigh: 5,
    highTierFrom: 200_000,
  },
};

const IMAGE_USD_PER_IMAGE: Record<NativeGrokImageModel, number> = {
  'grok-imagine-image-2.0': 0.04,
  'grok-imagine-image-quality': 0.05,
};
const VIDEO_USD_PER_SECOND = 0.08;

/** Undefined when the adapter reported no usage — the caller reports that as a
 *  missing cost rather than inventing one. */
export function grokTextCostFromUsage(
  usage: TokenUsage | undefined,
  model: NativeGrokTextModel
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

/** Exact, not an estimate: xAI bills a flat rate per image returned. */
export function grokImageCost(
  numImages: number,
  model: NativeGrokImageModel
): Microdollars {
  return usdToMicros(numImages * IMAGE_USD_PER_IMAGE[model]);
}

/** Pre-flight estimate; the charge that lands comes from {@link grokVideoCost}. */
export function grokVideoDurationCost(seconds: number): Microdollars {
  return usdToMicros(seconds * VIDEO_USD_PER_SECOND);
}

/** xAI's exact reported charge (USD). Undefined when it reported none. */
export function grokVideoCost(
  costUsd: number | undefined
): Microdollars | undefined {
  if (costUsd === undefined || !Number.isFinite(costUsd)) return undefined;
  return usdToMicros(costUsd);
}
