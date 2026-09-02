/**
 * Pure assembly of the exact fal request for an image generation — endpoint
 * resolution (edit endpoint when reference images ride along), per-model
 * prompt truncation, and the model-specific options object. Shared by
 * `generateImageWithProvider` and the scene editor's optimised-prompt
 * preview, so what the user sees is what fal receives — the image analogue
 * of `buildMotionRequest` (#873). Client-safe: no env, no adapters.
 */

import {
  nativeGeminiImageModel,
  type GeminiImageResolution,
  type NativeGeminiImageModel,
} from '@/lib/ai/gemini-native';
import {
  capReferenceImages,
  getEditEndpoint,
  getTextToImageModelId,
  IMAGE_MODELS,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_SIZE,
  type AspectRatio,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import {
  clampDimensions,
  pickImageResolution,
  resolutionDimensions,
  tierForShortEdge,
  RESOLUTIONS,
  tiersForTokens,
  type PixelBounds,
  type Resolution,
} from '@/lib/constants/resolutions';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'image', 'build-image-request']);

export type ImageGenerationParams = {
  model: TextToImageModel;
  prompt: string;
  imageSize?: ImageSize;
  numImages?: number;
  seed?: number;
  outputFormat?: 'jpeg' | 'png' | 'webp';
  numInferenceSteps?: number;
  guidanceScale?: number;
  negativePrompt?: string;
  loras?: Array<{ path: string; scale: number }>;
  embeddings?: Array<{ path: string; tokens: string[] }>;

  // Model-specific
  style?: string;
  colors?: Array<{ r: number; g: number; b: number }>;
  /** Output resolution tier (#1449). Resolved per model — see IMAGE_RESOLUTION. */
  resolution?: Resolution;
  enhancePrompt?: boolean;
  safetyTolerance?: number;
  acceleration?: 'none' | 'regular' | 'high';
  enablePromptExpansion?: boolean;
  referenceImageUrls?: string[];
};

const ASPECT_RATIO_MAP = {
  square_hd: '1:1',
  portrait_16_9: '9:16',
  landscape_16_9: '16:9',
} as const satisfies Record<ImageSize, string>;

type AspectRatioValue = (typeof ASPECT_RATIO_MAP)[ImageSize];

function imageSizeToAspectRatio(imageSize: ImageSize): AspectRatioValue {
  return ASPECT_RATIO_MAP[imageSize];
}

/**
 * How each model takes a resolution ask (#1449), transcribed from its fal
 * `llms.txt`. Two shapes, because fal has two:
 *
 *   - `tokens` — the model's own `resolution` enum; the tier picks the nearest.
 *   - `pixels` — `image_size` takes `{width, height}`; the tier's dimensions
 *     are clamped into the documented range.
 *
 * A model absent from this map renders at a fixed size (Nano Banana 2 Lite) or
 * publishes no range (Krea, Hunyuan, FLUX.2 Max, HiDream). Guessing a range
 * there would 422 the main generation path, so the tier leaves them on their
 * preset — see #1449.
 */
const IMAGE_RESOLUTION: Partial<
  Record<TextToImageModel, { tokens: string[] } | { pixels: PixelBounds }>
> = {
  nano_banana_2: { tokens: ['0.5K', '1K', '2K', '4K'] },
  nano_banana_pro: { tokens: ['1K', '2K', '4K'] },
  phota: { tokens: ['1K', '4K'] },
  grok_imagine_image: { tokens: ['1k', '2k'] },
  grok_imagine_image_quality: { tokens: ['1k', '2k'] },
  // Seedream's fal via is pixel-sized; its Ark via takes a token
  // (build-byteplus-image-request.ts).
  seedream_v5: { pixels: { minPixels: 1024 * 1024, maxPixels: 2048 * 2048 } },
  gpt_image_2: {
    pixels: {
      maxEdge: 3840,
      minPixels: 655_360,
      maxPixels: 8_294_400,
      multipleOf: 16,
    },
  },
  qwen_image: { pixels: { minPixels: 512 * 512, maxPixels: 2048 * 2048 } },
  flux_2_dev: { pixels: { minEdge: 512, maxEdge: 2048 } },
  flux_2_flash: { pixels: { minEdge: 512, maxEdge: 2048 } },
  flux_2_turbo: { pixels: { minEdge: 512, maxEdge: 2048 } },
};

/** The tokens the Gemini via admits — narrower than the fal enum (no 0.5K). */
const GEMINI_IMAGE_RESOLUTIONS = ['1K', '2K', '4K'] as const;

/**
 * The model's own spelling of the requested tier, or undefined when it takes
 * no `resolution` field.
 *
 * `tokens` overrides the fal enum for a via that admits a different set —
 * the same model can be reachable through more than one, and each spells the
 * ask in its own vocabulary.
 */
function resolveImageResolutionToken(
  model: TextToImageModel,
  resolution: Resolution | undefined,
  tokens?: readonly string[]
): string | undefined {
  if (!resolution) return undefined;
  if (tokens) return pickImageResolution(tokens, resolution);
  const capability = IMAGE_RESOLUTION[model];
  if (!capability || !('tokens' in capability)) return undefined;
  return pickImageResolution(capability.tokens, resolution);
}

/**
 * The tiers this model can actually deliver — what the resolution picker
 * offers for it (#1449). Empty when the model's output size is fixed, which
 * is the picker's cue to say so instead of showing tiers that do nothing.
 *
 * A token model is asked which tiers its enum covers; a pixel-sized one is
 * asked whether the tier's dimensions survive its documented range — FLUX.2
 * stops at 2048 per edge, so a "4K" pill there would promise a size it can
 * never return.
 */
export function imageResolutionTiers(
  model: TextToImageModel,
  aspectRatio: AspectRatio = DEFAULT_ASPECT_RATIO
): Resolution[] {
  const capability = IMAGE_RESOLUTION[model];
  if (!capability) return [];
  if ('tokens' in capability) return tiersForTokens(capability.tokens, 'image');
  return RESOLUTIONS.filter((tier) => {
    const clamped = clampDimensions(
      resolutionDimensions(tier, aspectRatio),
      capability.pixels
    );
    return tierForShortEdge(Math.min(clamped.width, clamped.height)) === tier;
  });
}

/**
 * The pixel size a tier actually buys on this model, or null when the tier
 * doesn't steer its size — a token model (the tier picks `2K`, but fal bills
 * per image either way) or one with no documented range, both of which render
 * at their own preset.
 *
 * Exported so the cost estimate is computed from the size the request will
 * really carry. Quoting a 4K ask at a flat stand-in under-reserves the credits
 * gating it; quoting a model the tier can't resize over-reserves (#1449).
 */
export function imageRequestDimensions(
  model: TextToImageModel,
  aspectRatio: AspectRatio,
  resolution: Resolution | undefined
): { width: number; height: number } | null {
  const capability = IMAGE_RESOLUTION[model];
  if (!resolution || !capability || !('pixels' in capability)) return null;
  return clampDimensions(
    resolutionDimensions(resolution, aspectRatio),
    capability.pixels
  );
}

/**
 * The `image_size` to send: explicit pixels for a model that accepts them,
 * otherwise the fal preset unchanged.
 */
function resolveImageSize(
  params: ImageGenerationParams
): ImageSize | { width: number; height: number } {
  const imageSize = params.imageSize ?? DEFAULT_IMAGE_SIZE;
  return (
    imageRequestDimensions(
      params.model,
      imageSizeToAspectRatio(imageSize),
      params.resolution
    ) ?? imageSize
  );
}

/** xAI's `aspectRatio_resolution` template, narrowed to the ratios we offer.
 *  Declared here, not imported, so this module stays adapter-free. */
export type GrokImagineImageSize = `${AspectRatioValue}_${'1k' | '2k'}`;

function truncatePromptForModel(
  prompt: string,
  model: TextToImageModel
): string {
  const maxLength = IMAGE_MODELS[model].maxPromptLength;
  if (prompt.length <= maxLength) return prompt;

  logger.warn(
    `Prompt truncated from ${prompt.length} to ${maxLength} chars for ${model}`
  );
  return prompt.slice(0, maxLength - 3) + '...';
}

function buildFalModelOptions(
  params: ImageGenerationParams
): Record<string, unknown> {
  switch (params.model) {
    case 'flux_2_dev':
      return {
        image_size: resolveImageSize(params),
        num_inference_steps: params.numInferenceSteps ?? 28,
        guidance_scale: params.guidanceScale ?? 2.5,
        enable_safety_checker: true,
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.acceleration && { acceleration: params.acceleration }),
        ...(params.enablePromptExpansion !== undefined && {
          enable_prompt_expansion: params.enablePromptExpansion,
        }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'flux_2_flash':
    case 'flux_2_turbo':
      return {
        image_size: resolveImageSize(params),
        // Turbo historically sent a 4-step default; Flash's schema has no
        // steps knob. Only Turbo keeps the field.
        ...(params.model === 'flux_2_turbo' && {
          num_inference_steps: params.numInferenceSteps ?? 4,
        }),
        guidance_scale: params.guidanceScale ?? 2.5,
        enable_safety_checker: true,
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        // Reference images route these models to `/flash/edit` or `/turbo/edit`
        // (EDIT_ENDPOINTS), which require `image_urls`. Omitting them sent an
        // edit request with no images and fal rejected every one with a 422
        // "Field required".
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'krea_2_turbo':
      return {
        image_size: resolveImageSize(params),
        enable_safety_checker: true,
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.acceleration && { acceleration: params.acceleration }),
        ...(params.enablePromptExpansion !== undefined && {
          enable_prompt_expansion: params.enablePromptExpansion,
        }),
        sync_mode: false,
      };

    case 'flux_2_max':
      return {
        image_size: resolveImageSize(params),
        enable_safety_checker: true,
        ...(params.safetyTolerance !== undefined && {
          safety_tolerance: params.safetyTolerance.toString(),
        }),
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'nano_banana_pro':
    case 'nano_banana_2':
    case 'nano_banana_2_lite':
      return {
        aspect_ratio: imageSizeToAspectRatio(
          params.imageSize ?? DEFAULT_IMAGE_SIZE
        ),
        // Lite is fixed 1K — the schema has no `resolution` field and 2K/4K
        // would 422. Pro/2 keep the existing default.
        ...(params.model !== 'nano_banana_2_lite' && {
          resolution:
            resolveImageResolutionToken(params.model, params.resolution) ??
            '2K',
        }),
        safety_tolerance: '6',
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'gpt_image_2':
      return {
        image_size: resolveImageSize(params),
        quality: 'high',
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'grok_imagine_image':
    case 'grok_imagine_image_quality':
      return {
        aspect_ratio: imageSizeToAspectRatio(
          params.imageSize ?? DEFAULT_IMAGE_SIZE
        ),
        resolution:
          resolveImageResolutionToken(params.model, params.resolution) ?? '2k',
        // 2.0 accepts low/medium; Quality Mode has no quality knob — the
        // model *is* the higher-fidelity tier.
        ...(params.model === 'grok_imagine_image' && { quality: 'medium' }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'phota':
      return {
        aspect_ratio: imageSizeToAspectRatio(
          params.imageSize ?? DEFAULT_IMAGE_SIZE
        ),
        // Phota only accepts '1K' or '4K'.
        resolution:
          resolveImageResolutionToken(params.model, params.resolution) ?? '1K',
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'hunyuan_image_v3':
      return {
        image_size: resolveImageSize(params),
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'qwen_image':
      return {
        image_size: resolveImageSize(params),
        enable_safety_checker: true,
        enable_prompt_expansion: true,
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'hidream_i1':
      return {
        image_size: { width: 1024, height: 1024 },
        num_inference_steps: params.numInferenceSteps ?? 50,
        guidance_scale: params.guidanceScale ?? 5,
        enable_safety_checker: true,
        ...(params.negativePrompt && {
          negative_prompt: params.negativePrompt,
        }),
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.loras && { loras: params.loras }),
        sync_mode: false,
      };

    case 'seedream_v5':
      return {
        image_size: resolveImageSize(params),
        enable_safety_checker: true,
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    default: {
      const _exhaustive: never = params.model;
      throw new Error(`Unsupported model: ${String(_exhaustive)}`);
    }
  }
}

/** Gemini native `aspectRatio_imageSize` (capital K). Lite is 1K-only. */
type GeminiNativeImageSize = `${AspectRatioValue}_${GeminiImageResolution}`;

export type GeminiImageRequest = {
  nativeModel: NativeGeminiImageModel;
  prompt: string;
  size: GeminiNativeImageSize;
  resolution: GeminiImageResolution;
  numImages: number;
  referenceImageUrls: string[];
};

/**
 * {@link buildImageRequest} for Gemini-native Nano Banana. Fal-only knobs
 * (safety_tolerance, output format, sync_mode) have no generateContent
 * counterpart and are dropped. Lite snaps every resolution to 1K.
 */
export function buildGeminiImageRequest(
  params: ImageGenerationParams
): GeminiImageRequest {
  const nativeModel = nativeGeminiImageModel(params.model);
  if (!nativeModel) {
    throw new Error(
      `Gemini image request built for a non-Nano-Banana model: ${params.model}`
    );
  }
  const aspectRatio = imageSizeToAspectRatio(
    params.imageSize ?? DEFAULT_IMAGE_SIZE
  );
  // Google's own tokens, not the fal enum: Gemini has no 0.5K, so the tier is
  // resolved against what this via actually admits (#1449). Narrowed by
  // lookup rather than asserted, like the xAI via.
  const picked = resolveImageResolutionToken(
    params.model,
    params.resolution,
    GEMINI_IMAGE_RESOLUTIONS
  );
  const resolution: GeminiImageResolution =
    nativeModel === 'gemini-3.1-flash-lite-image'
      ? '1K'
      : (GEMINI_IMAGE_RESOLUTIONS.find((r) => r === picked) ?? '2K');

  return {
    nativeModel,
    prompt: truncatePromptForModel(params.prompt, params.model),
    size: `${aspectRatio}_${resolution}`,
    resolution,
    numImages: params.numImages ?? 1,
    referenceImageUrls: capReferenceImages(
      params.model,
      params.referenceImageUrls ?? []
    ),
  };
}

/**
 * {@link buildImageRequest} for xAI-native Grok Imagine (#1167). Aspect-ratio
 * sized rather than pixel sized; the fal-only knobs (seed, inference steps,
 * safety tolerance, output format) have no Imagine counterpart and are dropped
 * rather than faked.
 */
export function buildGrokImageRequest(params: ImageGenerationParams): {
  prompt: string;
  size: GrokImagineImageSize;
  numImages: number;
  referenceImageUrls: string[];
} {
  const aspectRatio = imageSizeToAspectRatio(
    params.imageSize ?? DEFAULT_IMAGE_SIZE
  );
  // Imagine has no 4K tier — 4K lands on the highest it serves.
  const resolution =
    resolveImageResolutionToken(params.model, params.resolution) === '1k'
      ? '1k'
      : '2k';

  return {
    prompt: truncatePromptForModel(params.prompt, params.model),
    size: `${aspectRatio}_${resolution}`,
    numImages: params.numImages ?? 1,
    referenceImageUrls: capReferenceImages(
      params.model,
      params.referenceImageUrls ?? []
    ),
  };
}

/**
 * Resolve the endpoint and build the exact fal request body for an image
 * generation. `input` is the full request as fal sees it (prompt inline with
 * the model options); the submit path splits the prompt back out for the
 * TanStack AI adapter call.
 */
export function buildImageRequest(params: ImageGenerationParams): {
  /** Pricing Via — which API this endpoint is called on. Vendor is `model.vendor`. */
  via: 'fal';
  endpointId: string;
  input: { prompt: string } & Record<string, unknown>;
} {
  // Capped once here rather than in each `case` of buildFalModelOptions —
  // every model spreads `referenceImageUrls` itself, so a per-case cap is a
  // rule each new model has to remember, and fal rejects the whole request
  // when it's exceeded rather than truncating.
  const capped: ImageGenerationParams = params.referenceImageUrls?.length
    ? {
        ...params,
        referenceImageUrls: capReferenceImages(
          params.model,
          params.referenceImageUrls
        ),
      }
    : params;

  const editEndpoint = getEditEndpoint(capped.model);
  const endpointId =
    editEndpoint && capped.referenceImageUrls?.length
      ? editEndpoint
      : getTextToImageModelId(capped.model);

  return {
    via: 'fal',
    endpointId,
    input: {
      prompt: truncatePromptForModel(capped.prompt, capped.model),
      ...buildFalModelOptions(capped),
    },
  };
}
