import { getEnv } from '#env';
import {
  arkAdapterConfig,
  claimBytePlusVia,
  getArkApiKey,
  isBytePlusConfigured,
  loadBytePlusImage,
} from '@/models/server/byteplus-config';
import { isContentRejectionError } from '@/models/content-rejection';
import { billedFields } from '@/billing/billed-quantity';
import { falCostFromUnits } from '@/billing/server/fal-cost-billing';
import { FAL_GENERATION_TIMEOUT_MS } from '@/models/server/fal-deadline-fetch';
import { extractFalErrorMessage } from '@/models/fal-error';
import {
  grokImageCost,
  isNativeGrokImageModel,
  nativeGrokImageModel,
} from '@/models/grok-native';
import {
  geminiImageCost,
  isNativeGeminiImageModel,
  nativeGeminiImageModel,
} from '@/models/gemini-native';
import {
  withBytePlusQuotaRetry,
  withLlmRateLimitRetry,
} from '@/models/server/quota-retry';
import { resolveGoogleKeyForNewCall } from '@/models/server/google-key';
import {
  geminiStillSource,
  releaseGeminiFiles,
  type GeminiFile,
} from '@/models/server/gemini-files';
import { withGoogleRegionFallback } from '@/models/google-region';
import { isNativeBytePlusImageModel } from '@/models/models';
import type { MediaVia, ProductVia } from '@/models/via';
import { generateId } from '@/platform/id';
import { getLogger } from '@/platform/logger';
import { openstoryImage } from '@/gateway/server/adapter';
import { inProcessGateway } from '@/gateway/server/adapter/in-process';
import type { GatewayModel } from '@/gateway/server/catalog';
import {
  gatewayCannotRun,
  gatewayRouteKey,
  type GatewayRoutes,
} from '@/gateway/server/route';
import { storeGatewayOutput } from '@/gateway/server/storage';
import { UPLOAD_RIGHTS_CHECKED } from '@/gateway/server/submit-job';
import type { GatewayJobInput } from '@/gateway/schema';
import { workersSafeFetch } from '@/platform/server/ai/workers-safe-fetch';
import type { Microdollars } from '@/billing/money';
import type { ResolvedApiKey } from '@/models/server/db/api-keys';
import type {
  CredentialScopedDb,
  WorkflowScopedDb,
} from '@/platform/server/db/scoped-workflow';
import { buildBytePlusImageRequest } from '@/stills/build-byteplus-image-request';
import type { ImageGenerationParams } from '@/stills/build-image-request';
import {
  buildGeminiImageRequest,
  buildGrokImageBody,
  buildGrokImageRequest,
  buildImageRequest,
} from '@/stills/build-image-request';
import {
  recordMediaGenerationSpan,
  type AIObservabilityMeta,
} from '@/platform/server/observability/ai-otel';
import {
  ensureExternallyFetchableUrls,
  toDataOrCdnUrl,
} from '@/platform/server/storage/external-url';
import {
  generateImage,
  type ImageGenerationResult as AiImageGenerationResult,
} from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';
import { ThinkingLevel, createGeminiImage } from '@tanstack/ai-gemini';
import { createGrokImage } from '@tanstack/ai-grok';

export type { ImageGenerationParams } from '@/stills/build-image-request';

const logger = getLogger(['openstory', 'stills', 'image-generation']);

/** What the `openstory` route needs of the run; the route itself was decided at the trigger. */
type ImageGatewayCall = {
  /** The payload's routes; absent on a run triggered before #2434, which stays direct. */
  readonly routes: GatewayRoutes | undefined;
  readonly scopedDb: WorkflowScopedDb;
  readonly runId: string;
  /** Unique per attempt (`${instanceId}:${stepName}`): a retried step reuses the job and its hold. */
  readonly idempotencyKey: string;
};

/** Non-serializable options passed separately from ImageGenerationParams */
export type ImageGenerationOptions = {
  /** Null where no run carries routes; such a call stays direct. */
  gateway: ImageGatewayCall | null;
  credentials?: CredentialScopedDb;
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
  /** Pricing Via — which API served this; `openstory` was held and charged by the gateway. */
  via: ProductVia;
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
    /** Unit of `unitsBilled`, from `usage.billed.unit` when the adapter sent one. */
    billedUnit?: string;
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
    userId: options?.observability?.userId ?? options?.credentials?.userId,
  };

  const gateway = options?.gateway;
  const onGateway = gateway
    ? gatewayImageRequest(params, gateway.routes)
    : null;
  // The via of the attempt in flight, for the failure span.
  let via: ProductVia = onGateway ? 'openstory' : 'fal';
  try {
    const result =
      onGateway && gateway
        ? await generateOnGateway(params, onGateway, gateway)
        : // A Google location refusal re-runs once off Google (`google-region.ts`).
          await withGoogleRegionFallback('image generation', async () => {
            const route = await resolveImageVia(
              params.model,
              options?.credentials
            );
            via = route.via;
            return generateImageInternal(
              params,
              options,
              route.xaiKey,
              route.googleKey,
              route.via
            );
          });
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
      billedUnit: result.metadata.billedUnit,
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

/** The gateway model and body when the route for this model is `openstory` and the body can run there; else null (direct). */
export function gatewayImageRequest(
  params: ImageGenerationParams,
  routes: GatewayRoutes | undefined
): { model: GatewayModel; body: GatewayJobInput } | null {
  const nativeModel = nativeGrokImageModel(params.model);
  const route = nativeModel
    ? routes?.[gatewayRouteKey('grok', nativeModel)]
    : undefined;
  if (!nativeModel || route?.via !== 'openstory') return null;
  const body = buildGrokImageBody(params, nativeModel);
  // A routing rule on the run's own body, before any job: never a retry on another via.
  const reason = gatewayCannotRun(route.model, body);
  if (reason) {
    logger.info(`Image stays direct: ${reason}`, { model: params.model });
    return null;
  }
  return { model: route.model, body };
}

/** One gateway job: held, run, stored and charged in this step; a content refusal is released and rethrown. */
async function generateOnGateway(
  params: ImageGenerationParams,
  request: { model: GatewayModel; body: GatewayJobInput },
  call: ImageGatewayCall
): Promise<ImageGenerationResult> {
  const startTime = Date.now();
  const folder = `gateway/${generateId()}`;
  const transport = inProcessGateway({
    scopedDb: call.scopedDb,
    model: request.model,
    runId: call.runId,
    store: (media, index) =>
      storeGatewayOutput({
        media,
        kind: 'image',
        organizationId: call.scopedDb.organizationId,
        folder,
        index,
      }),
    // Product refs are our own stored uploads, classified when they were uploaded.
    uploadRightsChecked: UPLOAD_RIGHTS_CHECKED,
  });
  const result = await generateImage({
    adapter: openstoryImage(request.model.id, transport, {
      idempotencyKey: call.idempotencyKey,
    }),
    prompt: '',
    modelOptions: request.body,
    threadId: call.runId,
  });
  const imageUrls = result.images.flatMap((image) =>
    image.url ? [image.url] : []
  );
  if (imageUrls.length === 0) {
    throw new Error('No images returned from generation');
  }
  return {
    imageUrls,
    parameters: params,
    generatedAt: new Date().toISOString(),
    processingTimeMs: Date.now() - startTime,
    via: 'openstory',
    metadata: {
      prompt: params.prompt,
      model: params.model,
      endpointId: request.model.endpointId,
      numImages: imageUrls.length,
      dimensions: imageUrls.map(() => ({ width: 0, height: 0 })),
      file_sizes: imageUrls.map(() => 0),
      seed: params.seed,
      usedOwnKey: false,
    },
  };
}

async function resolveOptionalXaiKey(
  credentials?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (credentials) return credentials.resolveOptionalKey('xai');
  const platformKey = getEnv().XAI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

/** The via and its keys, in order: native xAI, Google, BytePlus (not for a BYOK fal organization), fal. */
async function resolveImageVia(
  model: ImageGenerationParams['model'],
  credentials: CredentialScopedDb | undefined
): Promise<{
  via: MediaVia;
  xaiKey: ResolvedApiKey | undefined;
  googleKey: ResolvedApiKey | undefined;
}> {
  const xaiKey = isNativeGrokImageModel(model)
    ? await resolveOptionalXaiKey(credentials)
    : undefined;
  const googleKey = isNativeGeminiImageModel(model)
    ? await resolveGoogleKeyForNewCall(credentials)
    : undefined;
  if (xaiKey) return { via: 'xai', xaiKey, googleKey };
  if (googleKey) return { via: 'google', xaiKey, googleKey };
  if (isNativeBytePlusImageModel(model) && isBytePlusConfigured()) {
    const falKey = credentials
      ? await credentials.resolveOptionalKey('fal')
      : getEnv().FAL_KEY
        ? { key: getEnv().FAL_KEY, source: 'platform' as const }
        : undefined;
    return {
      via: claimBytePlusVia({
        native: true,
        usingOwnFalKey: falKey?.source === 'organization',
      }),
      xaiKey,
      googleKey,
    };
  }
  return { via: 'fal', xaiKey, googleKey };
}

async function generateImageInternal(
  rawParams: ImageGenerationParams,
  options: ImageGenerationOptions | undefined,
  xaiKey: ResolvedApiKey | undefined,
  googleKey: ResolvedApiKey | undefined,
  via: MediaVia
): Promise<ImageGenerationResult> {
  const startTime = Date.now();
  const threadId = generateId();

  let result: AiImageGenerationResult;
  let endpoint: string;
  let usedOwnKey: boolean;
  let params: ImageGenerationParams = rawParams;
  let unitsBilled: number | undefined;
  let billedUnit: string | undefined;
  let cost: Microdollars | undefined;

  switch (via) {
    case 'google': {
      if (!googleKey) {
        throw new Error('Google image via selected with no Google key');
      }
      const gemini = buildGeminiImageRequest(rawParams);
      const uploadedStills: GeminiFile[] = [];
      const referenceParts = await Promise.all(
        gemini.referenceImageUrls.map(async (url) => ({
          type: 'image' as const,
          source: await geminiStillSource(url, googleKey.key, uploadedStills),
        }))
      ).catch(async (error: unknown) => {
        await releaseGeminiFiles(uploadedStills, googleKey.key);
        throw error;
      });
      const env = getEnv();
      const geminiAdapter = {
        ...(env.GEMINI_BASE_URL && {
          httpOptions: { baseUrl: env.GEMINI_BASE_URL },
        }),
      };
      const prompt = referenceParts.length
        ? [{ type: 'text' as const, content: gemini.prompt }, ...referenceParts]
        : gemini.prompt;
      try {
        result = await withLlmRateLimitRetry('gemini-image', () =>
          generateImage({
            adapter: createGeminiImage(
              gemini.nativeModel,
              googleKey.key,
              geminiAdapter
            ),
            prompt,
            threadId,
            size: gemini.size,
            numberOfImages: gemini.numImages,
            ...(gemini.minimalThinking && {
              modelOptions: {
                thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
              },
            }),
            timeout: FAL_GENERATION_TIMEOUT_MS,
            stream: false,
            debug: false,
          })
        );
      } finally {
        await releaseGeminiFiles(uploadedStills, googleKey.key);
      }
      endpoint = gemini.nativeModel;
      usedOwnKey = googleKey.source === 'organization';
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
              threadId,
              size: grok.size,
              numberOfImages: grok.numImages,
              modelOptions: { quality: 'medium' },
              timeout: FAL_GENERATION_TIMEOUT_MS,
              debug: false,
            })
          : await generateImage({
              adapter: createGrokImage(nativeModel, xaiKey.key, grokAdapter),
              prompt,
              threadId,
              size: grok.size,
              numberOfImages: grok.numImages,
              timeout: FAL_GENERATION_TIMEOUT_MS,
              debug: false,
            });
      endpoint = nativeModel;
      usedOwnKey = xaiKey.source === 'organization';
      break;
    }
    case 'fal': {
      const key = options?.credentials
        ? await options.credentials.resolveKey('fal')
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
      usedOwnKey = key.source === 'organization';

      // Bound so a hung fal.subscribe fails the workflow step and CF can retry
      // (#826). Native activity `timeout` since @tanstack/ai@0.44 / ai-fal@0.10.
      result = await generateImage({
        adapter: falImage(endpoint, { apiKey: key.key }),
        prompt,
        threadId,
        modelOptions,
        timeout: FAL_GENERATION_TIMEOUT_MS,
        debug: false,
      });
      const billed = billedFields(result.usage);
      unitsBilled = billed.unitsBilled;
      billedUnit = billed.billedUnit;
      cost = await falCostFromUnits(endpoint, unitsBilled, undefined, {
        missingUnitsReason: billed.missingUnitsReason,
      });
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
          threadId,
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
      const billed = billedFields(result.usage);
      unitsBilled = billed.unitsBilled;
      billedUnit = billed.billedUnit;
      cost = await falCostFromUnits(endpoint, unitsBilled, undefined, {
        missingUnitsReason: billed.missingUnitsReason,
      });
      break;
    }
  }

  // Native Gemini always answers with inline base64 and no hosted URL, and
  // BytePlus can — so a result is not guaranteed to hold a URL at all. That
  // is safe to represent inline only because no caller passes this value
  // between workflow steps: each stores the image in the same `step.do` that
  // generated it, so the bytes never reach a 1 MiB checkpoint (#1638,
  // #1645). `storeGeneratedPng` / `uploadImageFromUrl` open either form.
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
      billedUnit,
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
