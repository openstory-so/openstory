import { getEnv } from '#env';
import { estimateFalCost, type EffectiveFalPricing } from '@/lib/ai/fal-cost';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/lib/ai/fal-deadline-fetch';
import {
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { Microdollars } from '@/lib/billing/money';
import { type AspectRatio } from '@/lib/constants/aspect-ratios';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';
import {
  claimMotionProvider,
  getMotionProvider,
  type MotionProviderId,
} from '@/lib/media-providers';
import { MOTION_JSON_SCHEMAS } from '@/lib/motion/endpoint-map';
import {
  getDurationValues,
  numericOf,
  snapTo,
} from '@/lib/motion/motion-transform';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import { getLogger } from '@/lib/observability/logger';
import { buildModelInput } from './build-model-input';

export type GenerateMotionOptions = {
  scopedDb?: FalCredentialScopedDb;
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
   * clip (#873). Only emitted for models that accept reference images (Kling
   * v3 Pro, via its `elements` field); ignored by every other model.
   */
  referenceImages?: ReferenceImageDescription[];
};

const logger = getLogger(['openstory', 'motion', 'motion-generation']);

/** Snap a requested duration to the nearest valid value for a model.
 *  Reads supported durations from the model's JSON Schema and snaps directly. */
export function snapDuration(
  requested: number | undefined,
  modelKey: ImageToVideoModel
): number {
  const endpointId = IMAGE_TO_VIDEO_MODELS[modelKey].id;
  const jsonSchema = MOTION_JSON_SCHEMAS[endpointId];
  const validValues = getDurationValues(jsonSchema);

  const firstValue = validValues[0];
  if (firstValue === undefined) return requested ?? 5;

  const target = requested ?? numericOf(firstValue);
  return numericOf(snapTo(target, validValues));
}

export type MotionJobSubmission = {
  jobId: string;
  modelKey: ImageToVideoModel;
  /**
   * Who the job was submitted to. Job ids are provider-scoped, so polling MUST
   * go back to the same provider — re-deciding at poll time would send a fal
   * request id to another provider (or the reverse) if a key changed mid-run
   * (#1216).
   */
  provider: MotionProviderId;
  usedOwnKey: boolean;
  submittedAt: number;
};

/**
 * Submit a motion generation job without polling.
 * Returns the job ID so the workflow can poll with `context.sleep()` between steps.
 */
export async function submitMotionJob(
  options: GenerateMotionOptions
): Promise<MotionJobSubmission> {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;
  const { provider, key } = await claimMotionProvider(
    modelKey,
    options.scopedDb
  );
  const { jobId } = await provider.submit({ ...options, model: modelKey }, key);

  logger.info(`Job submitted: ${jobId}`);

  return {
    jobId,
    modelKey,
    provider: provider.id,
    usedOwnKey: key.source === 'team',
    submittedAt: Date.now(),
  };
}

/**
 * Check the status of a submitted motion job.
 * Designed to be called from individual workflow steps.
 *
 * `provider` comes from the submission rather than being re-resolved: polling
 * the wrong provider for a job id it never issued reads as a lost generation.
 * Defaults to `'fal'` so in-flight runs from before this field existed keep
 * polling fal — correct, since that is where they were submitted.
 */
export async function pollMotionJob(
  jobId: string,
  modelKey: ImageToVideoModel,
  scopedDb?: FalCredentialScopedDb,
  providerId: MotionProviderId = 'fal'
) {
  const provider = getMotionProvider(providerId);
  const key = await provider.claim(modelKey, scopedDb);
  if (!key) {
    throw new Error(
      `Motion job ${jobId} was submitted to ${provider.id} but no key is available to poll it`
    );
  }
  return provider.poll(jobId, modelKey, key);
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
  provider: string;
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
    provider: modelConfig.provider,
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
