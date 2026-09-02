/**
 * Pure assembly of the exact fal request for an image generation — endpoint
 * resolution (edit endpoint when reference images ride along), per-model
 * prompt truncation, and the model-specific options object. Shared by
 * `generateImageWithProvider` and the scene editor's optimised-prompt
 * preview, so what the user sees is what fal receives — the image analogue
 * of `buildMotionRequest` (#873). Client-safe: no env, no adapters.
 */

import {
  capReferenceImages,
  getEditEndpoint,
  getTextToImageModelId,
  IMAGE_MODELS,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import {
  clampDimensions,
  pickImageResolution,
  resolutionDimensions,
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

/**
 * The model's own spelling of the requested tier, or undefined when it takes
 * no `resolution` field.
 */
function resolveImageResolutionToken(
  model: TextToImageModel,
  resolution: Resolution | undefined
): string | undefined {
  const capability = IMAGE_RESOLUTION[model];
  if (!resolution || !capability || !('tokens' in capability)) return undefined;
  return pickImageResolution(capability.tokens, resolution);
}

/**
 * What the model will actually render at, when that isn't the tier asked for
 * — so a 4K pill on a fixed-1K model doesn't silently lie. Null when the
 * model serves the tier.
 */
export function imageResolutionNote(
  model: TextToImageModel,
  resolution: Resolution
): string | null {
  const capability = IMAGE_RESOLUTION[model];
  const name = IMAGE_MODELS[model].name;
  if (!capability) return `${name} renders at a fixed size`;
  if (!('tokens' in capability)) return null;
  const picked = pickImageResolution(capability.tokens, resolution);
  const wanted = pickImageResolution(['0.5K', '1K', '2K', '4K'], resolution);
  return picked && picked.toUpperCase() !== wanted?.toUpperCase()
    ? `${name} renders at ${picked}`
    : null;
}

/**
 * The `image_size` to send: explicit pixels for a model that accepts them,
 * otherwise the fal preset unchanged.
 */
function resolveImageSize(
  params: ImageGenerationParams
): ImageSize | { width: number; height: number } {
  const imageSize = params.imageSize ?? DEFAULT_IMAGE_SIZE;
  const capability = IMAGE_RESOLUTION[params.model];
  if (!params.resolution || !capability || !('pixels' in capability)) {
    return imageSize;
  }
  return clampDimensions(
    resolutionDimensions(params.resolution, imageSizeToAspectRatio(imageSize)),
    capability.pixels
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
