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
  resolution?: '1K' | '2K' | '4K';
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
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
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

    case 'flux_2_turbo':
      return {
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
        num_inference_steps: params.numInferenceSteps ?? 4,
        guidance_scale: params.guidanceScale ?? 2.5,
        enable_safety_checker: true,
        ...(params.seed !== undefined && { seed: params.seed }),
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        // Reference images route this model to `fal-ai/flux-2/turbo/edit`
        // (EDIT_ENDPOINTS), which requires `image_urls`. Omitting them sent an
        // edit request with no images and fal rejected every one with a 422
        // "Field required" — the only model in this switch that was missing it.
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'krea_2_turbo':
      return {
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
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
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
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
      return {
        aspect_ratio: imageSizeToAspectRatio(
          params.imageSize ?? DEFAULT_IMAGE_SIZE
        ),
        resolution: params.resolution ?? '2K',
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
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
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
        resolution: (params.resolution ?? '2K').toLowerCase(),
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
        // Phota only accepts '1K' or '4K' — map anything else to '1K'
        resolution: params.resolution === '4K' ? '4K' : '1K',
        ...(params.numImages !== undefined && { num_images: params.numImages }),
        ...(params.outputFormat && { output_format: params.outputFormat }),
        ...(params.referenceImageUrls?.length && {
          image_urls: params.referenceImageUrls,
        }),
        sync_mode: false,
      };

    case 'hunyuan_image_v3':
      return {
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
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
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
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
        image_size: params.imageSize ?? DEFAULT_IMAGE_SIZE,
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
  const resolution = params.resolution === '1K' ? '1k' : '2k';

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
