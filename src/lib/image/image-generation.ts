import { getEnv } from '#env';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { openaiDirectAllowed } from '@/lib/ai/create-adapter';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { FAL_GENERATION_TIMEOUT_MS } from '@/lib/ai/fal-deadline-fetch';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { IMAGE_MODELS } from '@/lib/ai/models';
import { openAiImageCostFromUsage } from '@/lib/ai/openai-cost';
import type { MediaVia } from '@/lib/ai/via';
import { type Microdollars } from '@/lib/billing/money';
import {
  DEFAULT_IMAGE_SIZE,
  type ImageSize,
} from '@/lib/constants/aspect-ratios';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import { buildImageRequest } from '@/lib/image/build-image-request';
import {
  recordMediaGenerationSpan,
  type AIObservabilityMeta,
} from '@/lib/observability/ai-otel';
import {
  ensureExternallyFetchableUrls,
  toVisionImageSource,
} from '@/lib/storage/external-url';
import { generateImage, type GeneratedImage } from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';
import { createOpenaiImage } from '@tanstack/ai-openai';

export type { ImageGenerationParams } from '@/lib/image/build-image-request';

/** Non-serializable options passed separately from ImageGenerationParams */
export type ImageGenerationOptions = {
  scopedDb?: CredentialScopedDb;
  /** PostHog LLM-analytics metadata for the generation span. */
  observability?: AIObservabilityMeta;
  onQueueUpdate?: (update: {
    status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
    logs?: string[];
    progress?: number;
  }) => void;
};

export type ImageGenerationResult = {
  imageUrls: string[];
  parameters: ImageGenerationParams;
  generatedAt: string;
  processingTimeMs: number;
  /** Pricing Via — which API served this. Vendor is `IMAGE_MODELS[model].vendor`. */
  via: MediaVia;
  metadata: {
    prompt: string;
    model: string;
    /** Provider endpoint actually submitted to (billing denominator). */
    endpointId: string;
    /** Fal-reported billed unit count. Recorded as a `model_usage_observations`
     * sample (the pricing cron's median reads that table, not the credit
     * ledger) and also spread into the transaction metadata as a billing
     * trail — see `recordFalUsageStep` (#1069). */
    unitsBilled?: number;
    /** Images this one call rendered. `unitsBilled` covers all of them, so the
     * cron divides by it to get a per-image median (#1069). */
    numImages?: number;
    dimensions: { width: number; height: number }[];
    file_sizes: number[];
    seed?: number;
    has_nsfw_concepts?: boolean[];
    cost?: Microdollars;
    requestId?: string;
    usedOwnKey: boolean;
  };
};

const OPENAI_SIZE: Record<ImageSize, '1024x1024' | '1024x1536' | '1536x1024'> =
  {
    square_hd: '1024x1024',
    portrait_16_9: '1024x1536',
    landscape_16_9: '1536x1024',
  };

function generatedImageToUrl(img: GeneratedImage): string | undefined {
  if (img.url) return img.url;
  if (img.b64Json) return `data:image/png;base64,${img.b64Json}`;
  return undefined;
}

function platformOpenAiKey(): ResolvedApiKey | undefined {
  const key = getEnv().OPENAI_API_KEY;
  return key ? { key, source: 'platform' } : undefined;
}

/**
 * GPT Image 2 goes native when a team or platform OpenAI key is present.
 * E2E stays hermetic — aimock does not cover api.openai.com.
 */
async function resolveOpenAiImageKey(
  params: ImageGenerationParams,
  options?: ImageGenerationOptions
): Promise<ResolvedApiKey | undefined> {
  if (params.model !== 'gpt_image_2' || !openaiDirectAllowed()) {
    return undefined;
  }
  if (options?.scopedDb) {
    return options.scopedDb.resolveOptionalKey('openai');
  }
  return platformOpenAiKey();
}

export async function generateImageWithProvider(
  params: ImageGenerationParams,
  options?: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  // Observability wraps the OUTER call, not the `generateImage()` inside —
  // see recordMediaGenerationSpan.
  const startedAt = Date.now();
  const attribution = {
    ...options?.observability,
    // `??` after the spread: an explicit `userId: undefined` in
    // `observability` would otherwise overwrite the derived id.
    userId: options?.observability?.userId ?? options?.scopedDb?.userId,
  };

  // Resolve via out here so the failure span names the API that rejected.
  const openaiKey = await resolveOpenAiImageKey(params, options);
  let via: MediaVia = openaiKey ? 'openai' : 'fal';

  try {
    const result = await generateImageInternal(params, options, openaiKey);
    via = result.via;
    recordMediaGenerationSpan({
      ...attribution,
      model: params.model,
      provider: result.via,
      activity: 'image',
      // Measured inside, so it excludes key resolution and the reference-URL
      // upload — the generation itself.
      durationMs: result.processingTimeMs,
      costMicros: result.metadata.cost,
      unitsBilled: result.metadata.unitsBilled,
      usedOwnKey: result.metadata.usedOwnKey,
      prompt: params.prompt,
      outputUrl: result.imageUrls,
    });
    return result;
  } catch (error) {
    const errorMessage = extractFalErrorMessage(error);
    recordMediaGenerationSpan({
      ...attribution,
      model: params.model,
      provider: via,
      activity: 'image',
      durationMs: Date.now() - startedAt,
      prompt: params.prompt,
      errorType: isContentRejectionError(error)
        ? 'content_filter'
        : 'provider_error',
      errorMessage,
    });

    // Re-throw with the full detail so workflow failure handlers get the real message
    if (errorMessage !== (error instanceof Error ? error.message : '')) {
      throw new Error(errorMessage, { cause: error });
    }
    throw error;
  }
}

async function generateOpenAiImage(
  params: ImageGenerationParams,
  openaiKey: ResolvedApiKey
): Promise<ImageGenerationResult> {
  const startTime = Date.now();
  const maxLength = IMAGE_MODELS[params.model].maxPromptLength;
  const promptText =
    params.prompt.length > maxLength
      ? `${params.prompt.slice(0, maxLength - 3)}...`
      : params.prompt;
  const size = OPENAI_SIZE[params.imageSize ?? DEFAULT_IMAGE_SIZE];
  const refs = params.referenceImageUrls ?? [];
  const prompt = refs.length
    ? [
        { type: 'text' as const, content: promptText },
        ...(await Promise.all(
          refs.map(async (url) => ({
            type: 'image' as const,
            source: await toVisionImageSource(url),
          }))
        )),
      ]
    : promptText;

  const result = await generateImage({
    adapter: createOpenaiImage('gpt-image-2', openaiKey.key, {
      allowUrlFetch: true,
    }),
    prompt,
    numberOfImages: params.numImages,
    size,
    modelOptions: {
      quality: 'high',
      output_format:
        params.outputFormat === 'jpeg'
          ? 'jpeg'
          : params.outputFormat === 'webp'
            ? 'webp'
            : 'png',
    },
    timeout: FAL_GENERATION_TIMEOUT_MS,
    debug: false,
  });

  const imageUrls = result.images
    .map(generatedImageToUrl)
    .filter((url): url is string => !!url);

  if (imageUrls.length === 0) {
    throw new Error('No images returned from generation');
  }

  const processingTimeMs = Date.now() - startTime;
  const cost = openAiImageCostFromUsage(result.usage, {
    size,
    numImages: imageUrls.length,
  });

  return {
    imageUrls,
    parameters: params,
    generatedAt: new Date().toISOString(),
    processingTimeMs,
    via: 'openai',
    metadata: {
      prompt: params.prompt,
      model: params.model,
      endpointId: 'gpt-image-2',
      numImages: imageUrls.length || params.numImages,
      dimensions: imageUrls.map(() => ({ width: 0, height: 0 })),
      file_sizes: imageUrls.map(() => 0),
      seed: params.seed,
      cost,
      requestId: result.id,
      usedOwnKey: openaiKey.source === 'team',
    },
  };
}

async function generateImageInternal(
  rawParams: ImageGenerationParams,
  options: ImageGenerationOptions | undefined,
  openaiKey: ResolvedApiKey | undefined
): Promise<ImageGenerationResult> {
  // Native PRs try their key first (resolveOptionalKey) and switch via.
  // Fal is the fallback and always claims.
  const via: MediaVia = openaiKey ? 'openai' : 'fal';

  switch (via) {
    case 'openai':
      if (!openaiKey) {
        throw new Error('OpenAI image via requires an API key');
      }
      return generateOpenAiImage(rawParams, openaiKey);
    case 'fal': {
      const key = options?.scopedDb
        ? await options.scopedDb.resolveKey('fal')
        : { key: getEnv().FAL_KEY, source: 'platform' as const };

      // Locally-served /r2/ reference URLs aren't reachable by real fal — swap
      // them for fal-storage uploads first (no-op in prod and e2e replay).
      const params: ImageGenerationParams = rawParams.referenceImageUrls?.length
        ? {
            ...rawParams,
            referenceImageUrls: await ensureExternallyFetchableUrls(
              rawParams.referenceImageUrls,
              key.key
            ),
          }
        : rawParams;
      const startTime = Date.now();

      // The exact request fal receives — shared with the scene editor's
      // optimised-prompt preview so the two can never drift. `via` is stamped
      // on the endpoint (pricing Via); vendor is `IMAGE_MODELS[model].vendor`.
      const { endpointId: endpoint, input } = buildImageRequest(params);
      const { prompt, ...modelOptions } = input;

      // Bound so a hung fal.subscribe fails the workflow step and CF can retry
      // (#826). Native activity `timeout` since @tanstack/ai@0.44 / ai-fal@0.10.
      const result = await generateImage({
        adapter: falImage(endpoint, { apiKey: key.key }),
        prompt,
        modelOptions,
        timeout: FAL_GENERATION_TIMEOUT_MS,
        debug: false,
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
      const cost = await falCostFromUnits(endpoint, result.usage?.unitsBilled);

      return {
        imageUrls,
        parameters: params,
        generatedAt: new Date().toISOString(),
        processingTimeMs,
        via,
        metadata: {
          prompt: params.prompt,
          model: params.model,
          endpointId: endpoint,
          unitsBilled: result.usage?.unitsBilled,
          // What the call actually returned, not what it was asked for: the median
          // divides `unitsBilled` by this, so a partial return (3 of 4 images)
          // recorded as 4 biases the per-image figure LOW — the direction that
          // under-gates, which is #1069's failure mode.
          numImages: imageUrls.length || params.numImages,
          dimensions: imageUrls.map(() => ({ width: 0, height: 0 })),
          file_sizes: imageUrls.map(() => 0),
          seed: params.seed,
          cost,
          // The adapter sets `id` to fal's request id — the join key to the
          // billing-events record the hourly reconcile audits this charge against.
          requestId: result.id,
          usedOwnKey: key.source === 'team',
        },
      };
    }
  }
}
