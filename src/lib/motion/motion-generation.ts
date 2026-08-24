import { getEnv } from '#env';
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
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import { assertMediaVia, type MediaVia } from '@/lib/ai/via';
import { type Microdollars } from '@/lib/billing/money';
import { type AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import { snapDuration } from '@/lib/motion/snap-duration';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { ensureExternallyFetchableUrl } from '@/lib/storage/external-url';
import {
  generateVideo,
  getVideoJobStatus,
  type TokenUsage,
} from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';
import { buildModelInput, buildMotionRequest } from './build-model-input';
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
  /** For audio-capable models (kling v3, veo3), pass `false` to suppress
   *  the model's native audio output (sfx/ambient/lip-sync). Omitting the
   *  flag lets the API schema default apply (true for audio-capable models). */
  generateAudio?: boolean;
  /**
   * Character + element reference images for identity consistency across the
   * clip (#873). Emitted when `resolveMotionEndpoint` says they go on the
   * wire: Kling `elements` and Seedance `image_urls[]`. Other models
   * substitute tokens with descriptions instead.
   */
  referenceImages?: ReferenceImageDescription[];
};

export type MotionJobSubmission = {
  jobId: string;
  modelKey: ImageToVideoModel;
  /**
   * Pricing Via — which API this job was submitted to. Job ids are via-scoped,
   * so polling MUST go back to the same via (#1216). Vendor is
   * `IMAGE_TO_VIDEO_MODELS[model].vendor`.
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

/**
 * Submit a motion generation job without polling.
 * Returns the job ID so the workflow can poll with `context.sleep()` between steps.
 */
export async function submitMotionJob(
  options: GenerateMotionOptions
): Promise<MotionJobSubmission> {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;

  const hasReferenceImages = (options.referenceImages?.length ?? 0) > 0;
  const endpoint = resolveMotionEndpoint(modelKey, hasReferenceImages);
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

  // Bound submit so a hung fal connection fails the step (#826).
  const job = await generateVideo({
    adapter: falVideo(endpoint.endpointId, { apiKey: key.key }),
    prompt: optimisedPrompt,
    modelOptions,
    timeout: FAL_REQUEST_TIMEOUT_MS,
    debug: false,
  });

  return {
    jobId: job.jobId,
    modelKey,
    via: endpoint.via,
    usedOwnKey: key.source === 'team',
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
  viaStamp: string = 'fal'
) {
  assertMediaVia(viaStamp);
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  const key = await resolveFalMotionKey(scopedDb);
  return await getVideoJobStatus({
    adapter: falVideo(modelConfig.id, {
      apiKey: key.key,
      fetch: createDeadlineFetch(FAL_REQUEST_TIMEOUT_MS, 'Motion job status'),
    }),
    jobId,
  });
}

export async function motionCostFromUsage(
  _via: MediaVia,
  usage: TokenUsage | undefined,
  ctx: { modelKey: ImageToVideoModel; hasReferenceImages: boolean }
) {
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

  const providerInput = buildModelInput(options, modelConfig, modelKey);
  const cost = estimateFalCost(
    modelConfig.id,
    {
      durationSeconds: validatedDuration,
      resolution:
        'resolution' in providerInput &&
        typeof providerInput.resolution === 'string'
          ? providerInput.resolution
          : undefined,
    },
    pricing
  );

  return {
    cost,
    duration: validatedDuration,
    model: modelConfig.id,
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
