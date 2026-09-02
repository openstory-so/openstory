import { getEnv } from '#env';
import {
  arkAdapterConfig,
  claimBytePlusVia,
  getArkApiKey,
  isBytePlusConfigured,
  loadBytePlusImage,
} from '@/lib/ai/byteplus-config';
import { withBytePlusQuotaRetry } from '@/lib/ai/byteplus-rate-limit';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { FAL_GENERATION_TIMEOUT_MS } from '@/lib/ai/fal-deadline-fetch';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  grokImageCost,
  isNativeGrokImageModel,
  nativeGrokImageModel,
} from '@/lib/ai/grok-native';
import {
  geminiImageCost,
  isNativeGeminiImageModel,
  nativeGeminiImageModel,
} from '@/lib/ai/gemini-native';
import { withLlmRateLimitRetry } from '@/lib/ai/llm-rate-limit';
import { isNativeBytePlusImageModel } from '@/lib/ai/models';
import type { MediaVia } from '@/lib/ai/via';
import { workersSafeFetch } from '@/lib/ai/workers-safe-fetch';
import { type Microdollars } from '@/lib/billing/money';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import { buildBytePlusImageRequest } from '@/lib/image/build-byteplus-image-request';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import {
  buildGeminiImageRequest,
  buildGrokImageRequest,
  buildImageRequest,
} from '@/lib/image/build-image-request';
import {
  recordMediaGenerationSpan,
  type AIObservabilityMeta,
} from '@/lib/observability/ai-otel';
import {
  ensureExternallyFetchableUrls,
  toDataOrCdnUrl,
  toVisionImageSource,
} from '@/lib/storage/external-url';
import {
  generateImage,
  type ImageGenerationResult as AiImageGenerationResult,
} from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';
import { createGeminiImage } from '@tanstack/ai-gemini';
import { createGrokImage } from '@tanstack/ai-grok';

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

  // Same order as video: native xAI first so an xAI-only deploy never
  // hits resolveKey('fal'), then Google when the model is a Nano Banana
  // and a Google key resolves, then BytePlus (platform Ark, vetoed for a
  // BYOK fal team).
  const xaiKey = isNativeGrokImageModel(params.model)
    ? await resolveOptionalXaiKey(options?.scopedDb)
    : undefined;
  const googleKey = isNativeGeminiImageModel(params.model)
    ? await resolveOptionalGoogleKey(options?.scopedDb)
    : undefined;
  let via: MediaVia;
  if (xaiKey) {
    via = 'xai';
  } else if (googleKey) {
    via = 'google';
  } else if (
    isNativeBytePlusImageModel(params.model) &&
    isBytePlusConfigured()
  ) {
    const falKey = options?.scopedDb
      ? await options.scopedDb.resolveOptionalKey('fal')
      : getEnv().FAL_KEY
        ? { key: getEnv().FAL_KEY, source: 'platform' as const }
        : undefined;
    via = claimBytePlusVia({
      native: true,
      usingOwnFalKey: falKey?.source === 'team',
    });
  } else {
    via = 'fal';
  }

  try {
    const result = await generateImageInternal(
      params,
      options,
      xaiKey,
      googleKey,
      via
    );
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

async function resolveOptionalXaiKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('xai');
  const platformKey = getEnv().XAI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

async function resolveOptionalGoogleKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('google');
  const platformKey = getEnv().GEMINI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

async function generateImageInternal(
  rawParams: ImageGenerationParams,
  options: ImageGenerationOptions | undefined,
  xaiKey: ResolvedApiKey | undefined,
  googleKey: ResolvedApiKey | undefined,
  via: MediaVia
): Promise<ImageGenerationResult> {
  const startTime = Date.now();

  let result: AiImageGenerationResult;
  let endpoint: string;
  let usedOwnKey: boolean;
  let params: ImageGenerationParams = rawParams;
  let unitsBilled: number | undefined;
  let cost: Microdollars | undefined;

  switch (via) {
    case 'google': {
      if (!googleKey) {
        throw new Error('Google image via selected with no Google key');
      }
      const gemini = buildGeminiImageRequest(rawParams);
      const referenceParts = await Promise.all(
        gemini.referenceImageUrls.map(async (url) => ({
          type: 'image' as const,
          source: await toVisionImageSource(url, undefined, { inline: true }),
        }))
      );
      const env = getEnv();
      const geminiAdapter = {
        ...(env.GEMINI_BASE_URL && {
          httpOptions: { baseUrl: env.GEMINI_BASE_URL },
        }),
      };
      const prompt = referenceParts.length
        ? [{ type: 'text' as const, content: gemini.prompt }, ...referenceParts]
        : gemini.prompt;
      result = await withLlmRateLimitRetry('gemini-image', () =>
        generateImage({
          adapter: createGeminiImage(
            gemini.nativeModel,
            googleKey.key,
            geminiAdapter
          ),
          prompt,
          size: gemini.size,
          numberOfImages: gemini.numImages,
          timeout: FAL_GENERATION_TIMEOUT_MS,
          stream: false,
          debug: false,
        })
      );
      endpoint = gemini.nativeModel;
      usedOwnKey = googleKey.source === 'team';
      break;
    }
    case 'xai': {
      if (!xaiKey) {
        throw new Error('xAI image via selected with no xAI key');
      }
      const nativeModel = nativeGrokImageModel(rawParams.model);
      if (!nativeModel) {
        throw new Error(
          `xAI image via selected for a non-Grok model: ${rawParams.model}`
        );
      }
      const grok = buildGrokImageRequest(rawParams);
      const referenceParts = await Promise.all(
        grok.referenceImageUrls.map(async (url) => ({
          type: 'image' as const,
          source: { type: 'url' as const, value: await toDataOrCdnUrl(url) },
        }))
      );
      const env = getEnv();
      const grokAdapter = {
        fetch: workersSafeFetch,
        ...(env.XAI_BASE_URL && { baseURL: env.XAI_BASE_URL }),
      };
      const prompt = referenceParts.length
        ? [{ type: 'text' as const, content: grok.prompt }, ...referenceParts]
        : grok.prompt;
      result =
        nativeModel === 'grok-imagine-image-2.0'
          ? await generateImage({
              adapter: createGrokImage(nativeModel, xaiKey.key, grokAdapter),
              prompt,
              size: grok.size,
              numberOfImages: grok.numImages,
              modelOptions: { quality: 'medium' },
              timeout: FAL_GENERATION_TIMEOUT_MS,
              debug: false,
            })
          : await generateImage({
              adapter: createGrokImage(nativeModel, xaiKey.key, grokAdapter),
              prompt,
              size: grok.size,
              numberOfImages: grok.numImages,
              timeout: FAL_GENERATION_TIMEOUT_MS,
              debug: false,
            });
      endpoint = nativeModel;
      usedOwnKey = xaiKey.source === 'team';
      break;
    }
    case 'fal': {
      const key = options?.scopedDb
        ? await options.scopedDb.resolveKey('fal')
        : { key: getEnv().FAL_KEY, source: 'platform' as const };

      // Locally-served /r2/ reference URLs aren't reachable by real fal — swap
      // them for fal-storage uploads first (no-op in prod and e2e replay).
      params = rawParams.referenceImageUrls?.length
        ? {
            ...rawParams,
            referenceImageUrls: await ensureExternallyFetchableUrls(
              rawParams.referenceImageUrls,
              key.key
            ),
          }
        : rawParams;

      // The exact request fal receives — shared with the scene editor's
      // optimised-prompt preview so the two can never drift. `via` is stamped
      // on the endpoint (pricing Via); vendor is `IMAGE_MODELS[model].vendor`.
      const built = buildImageRequest(params);
      const { prompt, ...modelOptions } = built.input;
      endpoint = built.endpointId;
      usedOwnKey = key.source === 'team';

      // Bound so a hung fal.subscribe fails the workflow step and CF can retry
      // (#826). Native activity `timeout` since @tanstack/ai@0.44 / ai-fal@0.10.
      result = await generateImage({
        adapter: falImage(endpoint, { apiKey: key.key }),
        prompt,
        modelOptions,
        timeout: FAL_GENERATION_TIMEOUT_MS,
        debug: false,
      });
      unitsBilled = result.usage?.unitsBilled;
      cost = await falCostFromUnits(endpoint, unitsBilled);
      break;
    }
    case 'byteplus': {
      const arkKey = getArkApiKey();
      if (!arkKey) {
        throw new Error('ARK_API_KEY is required for the BytePlus image via');
      }
      // Same as Grok: inline /r2/ as data URI or CDN URL so this path
      // needs no fal key.
      params = rawParams.referenceImageUrls?.length
        ? {
            ...rawParams,
            referenceImageUrls: await Promise.all(
              rawParams.referenceImageUrls.map((url) => toDataOrCdnUrl(url))
            ),
          }
        : rawParams;
      const request = buildBytePlusImageRequest(params);
      endpoint = request.modelId;
      const { apiKey, ...config } = arkAdapterConfig(
        arkKey,
        FAL_GENERATION_TIMEOUT_MS
      );
      const createBytePlusImage = await loadBytePlusImage();
      result = await withBytePlusQuotaRetry('image generate', () =>
        generateImage({
          adapter: createBytePlusImage(request.modelId, apiKey, config),
          prompt: request.prompt,
          size: request.size,
          ...(request.numberOfImages !== undefined && {
            numberOfImages: request.numberOfImages,
          }),
          modelOptions: request.modelOptions,
          // Explicit since @tanstack/ai 0.52 added streaming: the spread above
          // widens the options literal, so without this the return type stays
          // the streaming/non-streaming union.
          stream: false,
          debug: false,
        })
      );
      usedOwnKey = false;
      unitsBilled = result.usage?.unitsBilled;
      cost = await falCostFromUnits(endpoint, unitsBilled);
      break;
    }
  }

  const imageUrls = result.images
    .map((img) => {
      if (img.url) return img.url;
      if (img.b64Json) return `data:image/png;base64,${img.b64Json}`;
      return undefined;
    })
    .filter((url): url is string => !!url);

  if (imageUrls.length === 0) {
    throw new Error('No images returned from generation');
  }

  const processingTimeMs = Date.now() - startTime;
  if (via === 'xai') {
    const nativeModel = nativeGrokImageModel(params.model);
    if (!nativeModel) {
      throw new Error(
        `xAI image via selected for a non-Grok model: ${params.model}`
      );
    }
    cost = grokImageCost(imageUrls.length, nativeModel);
  } else if (via === 'google') {
    const nativeModel = nativeGeminiImageModel(params.model);
    if (!nativeModel) {
      throw new Error(
        `Google image via selected for a non-Nano-Banana model: ${params.model}`
      );
    }
    cost = geminiImageCost(
      imageUrls.length,
      nativeModel,
      buildGeminiImageRequest(params).resolution
    );
  }

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
      unitsBilled,
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
      usedOwnKey,
    },
  };
}
