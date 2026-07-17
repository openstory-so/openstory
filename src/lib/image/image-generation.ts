import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  getEditEndpoint,
  getTextToImageModelId,
  IMAGE_MODELS,
  type TextToImageModel,
} from '@/lib/ai/models';
import { type Microdollars, microsToUsd } from '@/lib/billing/money';
import {
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import {
  endSpanError,
  endSpanSuccess,
  startGenAISpan,
} from '@/lib/observability/tracer';

import { getEnv } from '#env';
import type { ScopedDb } from '@/lib/db/scoped';
import { ensureExternallyFetchableUrls } from '@/lib/storage/external-url';
import { generateImage } from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'image', 'image-generation']);
const IMAGE_GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

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
  traceName?: string;
};

/** Non-serializable options passed separately from ImageGenerationParams */
export type ImageGenerationOptions = {
  scopedDb?: ScopedDb;
  onQueueUpdate?: (update: {
    status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    logs?: string[];
    progress?: number;
  }) => void;
  /** User id for span attribution (Langfuse user.id, PostHog distinct_id) */
  userId?: string;
  /** Session id for Langfuse trace grouping (typically sequenceId) */
  sessionId?: string;
};

export type ImageGenerationResult = {
  imageUrls: string[];
  parameters: ImageGenerationParams;
  generatedAt: string;
  processingTimeMs: number;
  provider: 'fal';
  metadata: {
    prompt: string;
    model: string;
    dimensions: { width: number; height: number }[];
    file_sizes: number[];
    seed?: number;
    has_nsfw_concepts?: boolean[];
    cost?: Microdollars;
    requestId?: string;
    usedOwnKey: boolean;
  };
};

const ASPECT_RATIO_MAP: Record<ImageSize, string> = {
  square_hd: '1:1',
  portrait_16_9: '9:16',
  landscape_16_9: '16:9',
};

function imageSizeToAspectRatio(imageSize: ImageSize): string {
  return ASPECT_RATIO_MAP[imageSize];
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const parentSignal = init?.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('Image generation request timed out')),
      timeoutMs
    );

    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
}

function createFalAdapter(modelId: string, falApiKey?: string) {
  const key = falApiKey ?? getEnv().FAL_KEY;
  const config = {
    fetch: createTimeoutFetch(IMAGE_GENERATION_TIMEOUT_MS),
    ...(key ? { apiKey: key } : {}),
  };
  return falImage(modelId, config);
}

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

export async function generateImageWithProvider(
  params: ImageGenerationParams,
  options?: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  const modelId = getTextToImageModelId(params.model);

  const span = startGenAISpan(params.traceName ?? 'fal-image', {
    model: params.model,
    provider: 'fal',
    operation: 'generate_content',
    userId: options?.userId,
    sessionId: options?.sessionId,
    input: {
      prompt: params.prompt,
      imageSize: params.imageSize,
      ...(params.referenceImageUrls?.length && {
        referenceImageUrls: params.referenceImageUrls,
      }),
    },
  });

  try {
    const result = await generateImageInternal(params, modelId, options);

    if (result.metadata.cost) {
      span.setAttribute('gen_ai.usage.cost', microsToUsd(result.metadata.cost));
    }
    endSpanSuccess(span, { imageUrls: result.imageUrls });
    return result;
  } catch (error) {
    const errorMessage = extractFalErrorMessage(error);
    endSpanError(span, errorMessage);

    // Re-throw with the full detail so workflow failure handlers get the real message
    if (errorMessage !== (error instanceof Error ? error.message : '')) {
      throw new Error(errorMessage, { cause: error });
    }
    throw error;
  }
}
// @TODO: TB Mar 2026 - this needs to be updated to be typesafe. Especially after the work put in on Tanstack AI to keep it safe
async function generateImageInternal(
  rawParams: ImageGenerationParams,
  modelId: string,
  options?: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  // Get the fal API key - byok or global. Resolved BEFORE normalizing
  // reference URLs: the fal-storage upload below authenticates with this key,
  // so on a BYOK-only deployment (no platform FAL_KEY) the platform key would
  // be empty and the upload would fail with "Authorization header is required"
  // before we ever reach generation (#924).
  const falApiKeyInfo = options?.scopedDb
    ? await options.scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  // Locally-served /r2/ reference URLs aren't reachable by real fal — swap
  // them for fal-storage uploads first (no-op in prod and e2e replay).
  const params: ImageGenerationParams = rawParams.referenceImageUrls?.length
    ? {
        ...rawParams,
        referenceImageUrls: await ensureExternallyFetchableUrls(
          rawParams.referenceImageUrls,
          falApiKeyInfo.key
        ),
      }
    : rawParams;
  const prompt = truncatePromptForModel(params.prompt, params.model);
  const startTime = Date.now();

  const modelOptions = buildFalModelOptions(params);

  // Switch to edit endpoint for models with reference images
  let endpoint = modelId;
  const editEndpoint = getEditEndpoint(params.model);
  if (editEndpoint && params.referenceImageUrls?.length) {
    endpoint = editEndpoint;
  }

  const adapter = createFalAdapter(endpoint, falApiKeyInfo.key);

  logger.info('generateImage request', {
    data: JSON.stringify(
      {
        model: params.model,
        endpoint,
        keySource: falApiKeyInfo.source,
        prompt,
        modelOptions,
        referenceImageUrls: params.referenceImageUrls ?? [],
      },
      null,
      2
    ),
  });

  const result = await generateImage({
    adapter,
    prompt,
    modelOptions,
    debug: false,
  });

  logger.info('generateImage response', {
    data: JSON.stringify(
      {
        model: params.model,
        endpoint,
        imageUrls: result.images.map((img) => img.url),
      },
      null,
      2
    ),
  });

  const imageUrls = result.images
    .map((img) => img.url)
    .filter((url): url is string => !!url);

  if (imageUrls.length === 0) {
    throw new Error('No images returned from generation');
  }

  const processingTimeMs = Date.now() - startTime;

  // Exact cost from fal's reported billed units (resolution/style premiums are
  // already baked into the count by fal).
  const cost = falCostFromUnits(endpoint, result.usage?.unitsBilled);

  return {
    imageUrls,
    parameters: params,
    generatedAt: new Date().toISOString(),
    processingTimeMs,
    provider: 'fal',
    metadata: {
      prompt: params.prompt,
      model: params.model,
      dimensions: imageUrls.map(() => ({ width: 0, height: 0 })),
      file_sizes: imageUrls.map(() => 0),
      seed: params.seed,
      cost,
      usedOwnKey: falApiKeyInfo.source === 'team',
    },
  };
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
      return {
        aspect_ratio: imageSizeToAspectRatio(
          params.imageSize ?? DEFAULT_IMAGE_SIZE
        ),
        resolution: (params.resolution ?? '2K').toLowerCase(),
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
        resolution: params.resolution === '4K' ? '4K' : ('1K' as '1K' | '4K'),
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
