import { getEnv } from '#env';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { FAL_GENERATION_TIMEOUT_MS } from '@/lib/ai/fal-deadline-fetch';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  grokImageCost,
  isNativeGrokImageModel,
  nativeGrokImageModel,
} from '@/lib/ai/grok-native';
import type { MediaVia } from '@/lib/ai/via';
import { workersSafeFetch } from '@/lib/ai/workers-safe-fetch';
import { type Microdollars } from '@/lib/billing/money';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import {
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
} from '@/lib/storage/external-url';
import { generateImage } from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';
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

  // Resolve via out here so the failure span names the API that rejected.
  const xaiKey = isNativeGrokImageModel(params.model)
    ? await resolveOptionalXaiKey(options?.scopedDb)
    : undefined;
  let via: MediaVia = xaiKey ? 'xai' : 'fal';

  try {
    const result = await generateImageInternal(params, options, xaiKey);
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

async function generateImageInternal(
  rawParams: ImageGenerationParams,
  options: ImageGenerationOptions | undefined,
  xaiKey: ResolvedApiKey | undefined
): Promise<ImageGenerationResult> {
  const via: MediaVia = xaiKey ? 'xai' : 'fal';
  const startTime = Date.now();

  let result: Awaited<ReturnType<typeof generateImage>>;
  let endpoint: string;
  let usedOwnKey: boolean;
  let params: ImageGenerationParams = rawParams;
  let unitsBilled: number | undefined;
  let cost: Microdollars | undefined;

  switch (via) {
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
  }

  const imageUrls = result.images
    .map((img) => img.url)
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
