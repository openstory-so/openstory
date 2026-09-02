import { getEnv } from '#env';
import { toArkMediaUrl } from '@/lib/ai/byteplus-asset-ingest';
import {
  arkAdapterConfig,
  claimBytePlusVia,
  getArkApiKey,
  isBytePlusConfigured,
  loadBytePlusVideo,
} from '@/lib/ai/byteplus-config';
import { reportBytePlusPortraitFilterFallback } from '@/lib/ai/byteplus-observability';
import {
  BYTEPLUS_PORTRAIT_FILTER_NO_FAL_MESSAGE,
  isBytePlusPortraitFilterError,
} from '@/lib/ai/byteplus-portrait-filter';
import { bytePlusVideoUnitsBilled } from '@/lib/ai/byteplus-pricing';
import { withBytePlusQuotaRetry } from '@/lib/ai/byteplus-rate-limit';
import {
  estimateFalCost,
  falCostFromUnits,
  type EffectiveFalPricing,
} from '@/lib/ai/fal-cost';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/lib/ai/fal-deadline-fetch';
import {
  geminiVideoCostFromUsage,
  geminiVideoDurationCost,
  isNativeGeminiVideoModel,
  NATIVE_GEMINI_VIDEO_MODEL,
} from '@/lib/ai/gemini-native';
import {
  grokVideoCost,
  grokVideoDurationCost,
  isNativeGrokVideoModel,
  NATIVE_GROK_VIDEO_MODEL,
} from '@/lib/ai/grok-native';
import {
  DEFAULT_VIDEO_MODEL,
  getBytePlusVideoModelId,
  IMAGE_TO_VIDEO_MODELS,
  isNativeBytePlusVideoModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import { assertMediaVia, type MediaVia } from '@/lib/ai/via';
import { workersSafeFetch } from '@/lib/ai/workers-safe-fetch';
import { reportMissingBillingCost } from '@/lib/billing/billing-observability';
import { ZERO_MICROS, type Microdollars } from '@/lib/billing/money';
import { type AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Resolution } from '@/lib/constants/resolutions';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import { snapDuration } from '@/lib/motion/snap-duration';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import {
  ensureExternallyFetchableUrl,
  toDataOrCdnUrl,
} from '@/lib/storage/external-url';
import {
  generateVideo,
  getVideoJobStatus,
  type TokenUsage,
} from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';
import { createGeminiVideo } from '@tanstack/ai-gemini';
import { createGrokVideo } from '@tanstack/ai-grok';
import { buildBytePlusVideoRequest } from './build-byteplus-video-request';
import { buildGeminiVideoRequest } from './build-gemini-video-request';
import {
  getGeminiFileState,
  isGeminiFilesVideoUrl,
} from '@/lib/motion/video-storage';
import { buildGrokVideoRequest } from './build-grok-video-request';
import { buildMotionRequest } from './build-model-input';
import { resolveMotionEndpoint } from './resolve-motion-endpoint';

export type GenerateMotionOptions = {
  scopedDb?: CredentialScopedDb;
  imageUrl: string;
  prompt: string;
  model?: ImageToVideoModel;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  aspectRatio?: AspectRatio;
  /** Output resolution tier (#1449). Resolved against whatever `resolution`
   *  tokens the endpoint advertises — a model that stops at 1080p serves a 4K
   *  ask with 1080p rather than rejecting it. */
  resolution?: Resolution;
  /** For audio-capable models (kling v3, veo3), pass `false` to suppress
   *  the model's native audio output (sfx/ambient/lip-sync). Omitting the
   *  flag lets the API schema default apply (true for audio-capable models). */
  generateAudio?: boolean;
  /**
   * Character + element reference images for identity consistency across the
   * clip (#873). Emitted when `resolveMotionEndpoint` says they go on the
   * wire: Kling `elements`, Seedance `image_urls[]`, H3 Max
   * `reference_image_urls[]`, and Grok Imagine 1.5 native
   * `metadata.role: 'reference' | 'character'` prompt parts. Other models
   * substitute tokens with descriptions instead.
   */
  referenceImages?: ReferenceImageDescription[];
};

export type MotionJobSubmission = {
  jobId: string;
  modelKey: ImageToVideoModel;
  /**
   * Endpoint this job was submitted to. H3 Max with refs hits
   * `minimax/h3-max/reference-to-video`, not the catalog i2v id — polling
   * MUST use this stamp. Missing on in-flight runs from before the field:
   * poll falls back to `IMAGE_TO_VIDEO_MODELS[model].id`.
   */
  endpointId: string;
  /**
   * Pricing Via — which API this job was submitted to. Job ids are via-scoped,
   * so polling MUST go back to the same via. Re-deciding from live keys would
   * send a fal request id to xAI (or the reverse) if a key changed mid-run
   * (#1216). Vendor is `IMAGE_TO_VIDEO_MODELS[model].vendor`.
   */
  via: MediaVia;
  usedOwnKey: boolean;
  submittedAt: number;
};

async function resolveFalMotionKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey> {
  if (scopedDb) return scopedDb.resolveKey('fal');
  return { key: getEnv().FAL_KEY, source: 'platform' };
}

/** Undefined when the model isn't Grok or no xAI key exists — it then goes to
 *  fal as before (#1167). */
async function resolveOptionalXaiKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('xai');
  const platformKey = getEnv().XAI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

/** Undefined when the model isn't Omni Flash or no Google key exists — it
 *  then goes to fal as before. */
async function resolveOptionalGoogleKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('google');
  const platformKey = getEnv().GEMINI_API_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

function createNativeMotionAdapter(apiKey: string) {
  const env = getEnv();
  return createGrokVideo(NATIVE_GROK_VIDEO_MODEL, apiKey, {
    fetch: workersSafeFetch,
    ...(env.XAI_BASE_URL && { baseURL: env.XAI_BASE_URL }),
  });
}

function createNativeGeminiMotionAdapter(apiKey: string) {
  const env = getEnv();
  return createGeminiVideo(NATIVE_GEMINI_VIDEO_MODEL, apiKey, {
    // GEMINI_BASE_URL is the aimock hook for the native Google path,
    // mirroring XAI_BASE_URL above.
    ...(env.GEMINI_BASE_URL && {
      httpOptions: { baseUrl: env.GEMINI_BASE_URL },
    }),
  });
}

async function inlineNativeReferenceImages(
  references: ReferenceImageDescription[] | undefined
): Promise<ReferenceImageDescription[]> {
  if (!references?.length) return [];
  return Promise.all(
    references.map(async (ref) => ({
      ...ref,
      referenceImageUrl: await toDataOrCdnUrl(ref.referenceImageUrl),
    }))
  );
}

async function resolveOptionalFalKey(
  scopedDb?: CredentialScopedDb
): Promise<ResolvedApiKey | undefined> {
  if (scopedDb) return scopedDb.resolveOptionalKey('fal');
  const platformKey = getEnv().FAL_KEY;
  return platformKey ? { key: platformKey, source: 'platform' } : undefined;
}

async function submitFalMotionJob(
  options: GenerateMotionOptions,
  modelKey: ImageToVideoModel
): Promise<{ jobId: string; usedOwnKey: boolean; endpointId: string }> {
  const hasReferenceImages = (options.referenceImages?.length ?? 0) > 0;
  const endpoint = resolveMotionEndpoint(modelKey, hasReferenceImages, 'fal');
  const key = await resolveFalMotionKey(options.scopedDb);

  // Locally-served /r2/ image URLs aren't reachable by real fal — swap them
  // for a fal-storage upload first (no-op in prod and e2e replay).
  const imageUrl = await ensureExternallyFetchableUrl(
    options.imageUrl,
    key.key
  );

  // Reference URLs only need to be fetchable when they go on the wire
  // (`endpoint` or `inline`). Models with `references: 'none'` keep the raw
  // URLs: they are never sent, but the builder still needs tokens +
  // descriptions to substitute entity names in the prompt.
  const referenceImages =
    endpoint.references !== 'none' && options.referenceImages?.length
      ? await Promise.all(
          options.referenceImages.map(async (ref) => ({
            ...ref,
            referenceImageUrl: await ensureExternallyFetchableUrl(
              ref.referenceImageUrl,
              key.key
            ),
          }))
        )
      : options.referenceImages;

  const optionsWithFetchableUrls = {
    ...options,
    imageUrl,
    referenceImages,
    model: modelKey,
  };
  const modelInput = buildMotionRequest(
    optionsWithFetchableUrls,
    modelKey
  ).input;

  const { prompt: optimisedPrompt, ...modelOptions } = modelInput;
  if (typeof optimisedPrompt !== 'string') {
    throw new Error('Truncated prompt is not a string');
  }

  const job = await generateVideo({
    adapter: falVideo(endpoint.endpointId, { apiKey: key.key }),
    prompt: optimisedPrompt,
    modelOptions,
    timeout: FAL_REQUEST_TIMEOUT_MS,
    debug: false,
  });
  return {
    jobId: job.jobId,
    usedOwnKey: key.source === 'team',
    endpointId: endpoint.endpointId,
  };
}

async function fallbackBytePlusPortraitFilterToFal(
  error: unknown,
  operation: string,
  options: GenerateMotionOptions,
  modelKey: ImageToVideoModel
): Promise<{ jobId: string; usedOwnKey: boolean; endpointId: string }> {
  if (!isBytePlusPortraitFilterError(error)) throw error;
  const falKey = await resolveOptionalFalKey(options.scopedDb);
  if (!falKey) {
    throw new Error(BYTEPLUS_PORTRAIT_FILTER_NO_FAL_MESSAGE);
  }
  reportBytePlusPortraitFilterFallback(operation);
  return submitFalMotionJob(options, modelKey);
}

/**
 * Submit a motion generation job without polling.
 * Returns the job ID so the workflow can poll with `context.sleep()` between steps.
 */
export async function submitMotionJob(
  options: GenerateMotionOptions
): Promise<MotionJobSubmission> {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;

  // Same order as Grok (#1167): native key first, fal is the fallback.
  // `resolveKey('fal')` throws with no fal key, so an xAI-only (or
  // Google-only) deploy must not reach it. BytePlus is platform-only (no
  // resolveOptionalKey('byteplus')) and yields to a BYOK fal team.
  const xaiKey = isNativeGrokVideoModel(modelKey)
    ? await resolveOptionalXaiKey(options.scopedDb)
    : undefined;
  const googleKey = isNativeGeminiVideoModel(modelKey)
    ? await resolveOptionalGoogleKey(options.scopedDb)
    : undefined;

  const hasReferenceImages = (options.referenceImages?.length ?? 0) > 0;

  let via: MediaVia;
  if (xaiKey) {
    via = 'xai';
  } else if (googleKey) {
    via = 'google';
  } else if (isNativeBytePlusVideoModel(modelKey) && isBytePlusConfigured()) {
    const falKey = await resolveOptionalFalKey(options.scopedDb);
    via = claimBytePlusVia({
      native: true,
      usingOwnFalKey: falKey?.source === 'team',
    });
  } else {
    via = 'fal';
  }

  const endpoint = resolveMotionEndpoint(modelKey, hasReferenceImages, via);

  let jobId: string;
  let usedOwnKey: boolean;
  let stampedVia: MediaVia = endpoint.via;
  let stampedEndpointId = endpoint.endpointId;

  switch (endpoint.via) {
    case 'xai': {
      if (!xaiKey) {
        throw new Error('xAI motion via selected with no xAI key');
      }
      // Start frame and refs are inlined as data URIs so this path needs no
      // fal key. Same payload as the scene editor's Grok preview.
      const imageUrl = await toDataOrCdnUrl(options.imageUrl);
      const referenceImages = await inlineNativeReferenceImages(
        options.referenceImages
      );
      const { input } = buildGrokVideoRequest({
        prompt: options.prompt,
        imageUrl,
        duration: snapDuration(options.duration, modelKey),
        aspectRatio: options.aspectRatio,
        ...(options.resolution && { resolution: options.resolution }),
        referenceImages,
        model: modelKey,
      });
      const job = await generateVideo({
        adapter: createNativeMotionAdapter(xaiKey.key),
        prompt: input.prompt,
        duration: input.duration,
        ...(input.size && { size: input.size }),
        timeout: FAL_REQUEST_TIMEOUT_MS,
        debug: false,
      });
      jobId = job.jobId;
      usedOwnKey = xaiKey.source === 'team';
      break;
    }
    case 'google': {
      if (!googleKey) {
        throw new Error('Google motion via selected with no Google key');
      }
      // Start frame and refs are inlined as data URIs so this path needs no
      // fal key. Same payload as the scene editor's Gemini preview.
      const imageUrl = await toDataOrCdnUrl(options.imageUrl);
      const referenceImages = await inlineNativeReferenceImages(
        options.referenceImages
      );
      const { input } = buildGeminiVideoRequest({
        prompt: options.prompt,
        imageUrl,
        duration: options.duration,
        aspectRatio: options.aspectRatio,
        referenceImages,
        model: modelKey,
      });
      // Duration/size ride on `modelOptions.response_format` (with
      // `delivery: "uri"`). Passing them as generateVideo top-level
      // fields makes the adapter rebuild response_format without
      // delivery, and Google inlines the MP4 as a data: URL.
      const job = await generateVideo({
        adapter: createNativeGeminiMotionAdapter(googleKey.key),
        prompt: input.prompt,
        modelOptions: input.modelOptions,
        timeout: FAL_REQUEST_TIMEOUT_MS,
        debug: false,
      });
      jobId = job.jobId;
      usedOwnKey = googleKey.source === 'team';
      break;
    }
    case 'fal': {
      const fal = await submitFalMotionJob(options, modelKey);
      jobId = fal.jobId;
      usedOwnKey = fal.usedOwnKey;
      stampedEndpointId = fal.endpointId;
      break;
    }
    case 'byteplus': {
      const arkKey = getArkApiKey();
      if (!arkKey) {
        throw new Error('ARK_API_KEY is required for the BytePlus motion via');
      }
      // Every still Seedance sees — start frame and every reference — has
      // to be `asset://`. A public URL of a photorealistic face (including
      // a generated start frame) 400s as a possible real person.
      const falKey = await resolveOptionalFalKey(options.scopedDb);
      const imageUrl = await toArkMediaUrl(
        options.imageUrl,
        'Image',
        falKey?.key
      );
      const referenceImages = options.referenceImages?.length
        ? await Promise.all(
            options.referenceImages.map(async (ref) => ({
              ...ref,
              referenceImageUrl: await toArkMediaUrl(
                ref.referenceImageUrl,
                'Image',
                falKey?.key
              ),
            }))
          )
        : options.referenceImages;
      const request = buildBytePlusVideoRequest(
        { ...options, imageUrl, referenceImages },
        modelKey
      );
      const { apiKey, ...config } = arkAdapterConfig(
        arkKey,
        FAL_REQUEST_TIMEOUT_MS
      );
      const createBytePlusVideo = await loadBytePlusVideo();
      try {
        const job = await withBytePlusQuotaRetry('motion submit', () =>
          generateVideo({
            adapter: createBytePlusVideo(endpoint.endpointId, apiKey, config),
            prompt: request.prompt,
            size: request.size,
            ...(request.duration !== undefined && {
              duration: request.duration,
            }),
            modelOptions: request.modelOptions,
            timeout: FAL_REQUEST_TIMEOUT_MS,
            debug: false,
          })
        );
        jobId = job.jobId;
        usedOwnKey = false;
      } catch (error) {
        const fal = await fallbackBytePlusPortraitFilterToFal(
          error,
          'motion submit',
          options,
          modelKey
        );
        jobId = fal.jobId;
        usedOwnKey = fal.usedOwnKey;
        stampedVia = 'fal';
        stampedEndpointId = fal.endpointId;
      }
      break;
    }
  }

  return {
    jobId,
    modelKey,
    endpointId: stampedEndpointId,
    via: stampedVia,
    usedOwnKey,
    submittedAt: Date.now(),
  };
}

/**
 * Check the status of a submitted motion job.
 * Designed to be called from individual workflow steps.
 *
 * `via` comes from the submission rather than being re-resolved: polling the
 * wrong API for a job id it never issued reads as a lost generation.
 * Defaults to `'fal'` so in-flight runs from before this field existed keep
 * polling fal — correct, since that is where they were submitted.
 */
export async function pollMotionJob(
  jobId: string,
  modelKey: ImageToVideoModel,
  scopedDb?: CredentialScopedDb,
  viaStamp: string = 'fal',
  endpointId?: string
) {
  const via = assertMediaVia(viaStamp);
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];
  const falEndpointId = endpointId ?? modelConfig.id;

  switch (via) {
    case 'xai': {
      const key = await resolveOptionalXaiKey(scopedDb);
      if (!key) {
        throw new Error(
          `Motion job ${jobId} was submitted to xAI but no xAI key is available to poll it`
        );
      }
      return await getVideoJobStatus({
        adapter: createNativeMotionAdapter(key.key),
        jobId,
      });
    }
    case 'google': {
      const key = await resolveOptionalGoogleKey(scopedDb);
      if (!key) {
        throw new Error(
          `Motion job ${jobId} was submitted to Google but no Google key is available to poll it`
        );
      }
      const result = await getVideoJobStatus({
        adapter: createNativeGeminiMotionAdapter(key.key),
        jobId,
      });
      if (
        result.status === 'completed' &&
        result.url &&
        isGeminiFilesVideoUrl(result.url)
      ) {
        const fileState = await getGeminiFileState(result.url, key.key);
        if (fileState === 'FAILED') {
          return {
            ...result,
            status: 'failed' as const,
            error: 'Gemini Files API marked the generated video as FAILED',
          };
        }
        if (fileState !== 'ACTIVE') {
          return { jobId: result.jobId, status: 'processing' as const };
        }
      }
      return result;
    }
    case 'fal': {
      const key = await resolveFalMotionKey(scopedDb);
      // Bound a single status fetch — the workflow already budgets total poll
      // wall-clock across batches; this only prevents one hung HTTP call from
      // freezing a poll step forever (#826).
      return await getVideoJobStatus({
        adapter: falVideo(falEndpointId, {
          apiKey: key.key,
          fetch: createDeadlineFetch(
            FAL_REQUEST_TIMEOUT_MS,
            'Motion job status'
          ),
        }),
        jobId,
      });
    }
    case 'byteplus': {
      const arkKey = getArkApiKey();
      if (!arkKey) {
        throw new Error(
          'ARK_API_KEY is required to poll a BytePlus motion job'
        );
      }
      const modelId = getBytePlusVideoModelId(modelKey);
      if (!modelId) {
        throw new Error(`No BytePlus model id for motion model "${modelKey}"`);
      }
      const { apiKey, ...config } = arkAdapterConfig(
        arkKey,
        FAL_REQUEST_TIMEOUT_MS
      );
      const createBytePlusVideo = await loadBytePlusVideo();
      return await withBytePlusQuotaRetry('motion poll', () =>
        getVideoJobStatus({
          adapter: createBytePlusVideo(modelId, apiKey, config),
          jobId,
        })
      );
    }
  }
}

export async function motionCostFromUsage(
  via: MediaVia,
  usage: TokenUsage | undefined,
  ctx: { modelKey: ImageToVideoModel; hasReferenceImages: boolean }
) {
  switch (via) {
    case 'xai': {
      const cost = grokVideoCost(usage?.cost);
      if (cost === undefined) {
        reportMissingBillingCost({
          source: 'motion-cost-from-usage-xai',
          modelId: ctx.modelKey,
          metadata: { usage },
        });
      }
      return {
        endpointId: NATIVE_GROK_VIDEO_MODEL,
        unitsBilled: usage?.unitsBilled,
        cost: cost ?? ZERO_MICROS,
        recordFalUsage: false,
      };
    }
    case 'google': {
      // Omni bills per second of video, reported as output tokens on the
      // interaction's usage — priced at Google's published video-output rate.
      const cost = geminiVideoCostFromUsage(usage);
      if (cost === undefined) {
        reportMissingBillingCost({
          source: 'motion-cost-from-usage-google',
          modelId: ctx.modelKey,
          metadata: { usage },
        });
      }
      return {
        endpointId: NATIVE_GEMINI_VIDEO_MODEL,
        unitsBilled: usage?.unitsBilled,
        cost: cost ?? ZERO_MICROS,
        recordFalUsage: false,
      };
    }
    case 'fal': {
      const endpointId = resolveMotionEndpoint(
        ctx.modelKey,
        ctx.hasReferenceImages
      ).endpointId;
      return {
        endpointId,
        unitsBilled: usage?.unitsBilled,
        cost: await falCostFromUnits(endpointId, usage?.unitsBilled),
        recordFalUsage: true,
      };
    }
    case 'byteplus': {
      const endpointId = getBytePlusVideoModelId(ctx.modelKey);
      if (!endpointId) {
        throw new Error(
          `No BytePlus model id for motion model "${ctx.modelKey}"`
        );
      }
      const unitsBilled = bytePlusVideoUnitsBilled(usage?.totalTokens);
      return {
        endpointId,
        unitsBilled,
        cost: await falCostFromUnits(endpointId, unitsBilled),
        recordFalUsage: false,
      };
    }
  }
}

/**
 * Pre-flight motion cost estimate + metadata, computed before the job runs.
 * `cost` is a rough estimate for the credit gate (null = no honest estimate;
 * gate with `gateEstimate`) — the exact charge comes from `falCostFromUnits`
 * once fal reports `unitsBilled`. Pass `getEffectiveFalPricing()` as
 * `pricing` on server paths.
 */
export function calculateMotionMetadata(
  options: GenerateMotionOptions,
  pricing: Record<string, EffectiveFalPricing>
): {
  cost: Microdollars | null;
  duration: number;
  model: string;
  vendor: string;
} {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  const validatedDuration = snapDuration(options.duration, modelKey);

  // Flat per-second rate, so no `model_pricing` row is needed. Pure, so it
  // can't know whether a key resolves — over-estimating a Grok render that
  // lands on fal is the safe direction (fal's rate is within a cent).
  if (isNativeGrokVideoModel(modelKey)) {
    return {
      cost: grokVideoDurationCost(validatedDuration),
      duration: validatedDuration,
      model: modelConfig.id,
      vendor: modelConfig.vendor,
    };
  }

  // Same shape for Omni Flash: Google bills a fixed token count per second
  // of video, so the estimate needs no `model_pricing` row either.
  if (isNativeGeminiVideoModel(modelKey)) {
    return {
      cost: geminiVideoDurationCost(validatedDuration),
      duration: validatedDuration,
      model: modelConfig.id,
      vendor: modelConfig.vendor,
    };
  }

  const { endpointId, input } = buildMotionRequest(options, modelKey);
  const cost = estimateFalCost(
    endpointId,
    {
      durationSeconds: validatedDuration,
      resolution:
        'resolution' in input && typeof input.resolution === 'string'
          ? input.resolution
          : undefined,
    },
    pricing
  );

  return {
    cost,
    duration: validatedDuration,
    model: endpointId,
    vendor: modelConfig.vendor,
  };
}

type FalQueueStatus = {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';
  queue_position?: number;
  response_url?: string;
  cancel_url?: string;
  status_url?: string;
  logs?: Array<{ level: string; message: string }>;
  metrics?: { inference_time?: number };
};

/** Authenticated fetch against the fal queue API */
async function falQueueFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const apiKey = getEnv().FAL_KEY;
  if (!apiKey) {
    throw new Error('FAL_KEY environment variable is required');
  }

  const deadlineFetch = createDeadlineFetch(
    FAL_REQUEST_TIMEOUT_MS,
    'Motion queue request'
  );
  const response = await deadlineFetch(url, {
    ...init,
    headers: new Headers({
      Authorization: `Key ${apiKey}`,
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    }),
  });

  if (!response.ok) {
    throw new Error(`Fal API error: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function checkMotionStatus(
  statusUrl: string
): Promise<FalQueueStatus> {
  const response = await falQueueFetch(statusUrl);
  return response.json();
}

export async function getMotionResult(
  responseUrl: string
): Promise<{ video: { url: string } }> {
  const response = await falQueueFetch(responseUrl);
  return response.json();
}

export async function cancelMotionGeneration(cancelUrl: string): Promise<void> {
  await falQueueFetch(cancelUrl, { method: 'PUT' });
}
