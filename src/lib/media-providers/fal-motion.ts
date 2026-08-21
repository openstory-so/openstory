import { getEnv } from '#env';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import {
  createDeadlineFetch,
  FAL_REQUEST_TIMEOUT_MS,
} from '@/lib/ai/fal-deadline-fetch';
import {
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';
import { buildMotionRequest } from '@/lib/motion/build-model-input';
import type { GenerateMotionOptions } from '@/lib/motion/motion-generation';
import { resolveMotionEndpoint } from '@/lib/motion/resolve-motion-endpoint';
import { getLogger } from '@/lib/observability/logger';
import { ensureExternallyFetchableUrl } from '@/lib/storage/external-url';
import { generateVideo, getVideoJobStatus } from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';
import type { MotionProvider } from './types';

const logger = getLogger(['openstory', 'motion', 'motion-generation']);

function falPricingEndpointId(
  modelKey: ImageToVideoModel,
  ctx: { hasReferenceImages: boolean }
): string {
  return resolveMotionEndpoint(modelKey, ctx.hasReferenceImages).endpointId;
}

async function resolveFalKey(
  scopedDb?: FalCredentialScopedDb
): Promise<ResolvedApiKey> {
  // Always claims: `resolveKey('fal')` throws with no key, matching the
  // pre-seam helper. Platform-only callers (scripts) skip scopedDb.
  if (scopedDb) return scopedDb.resolveKey('fal');
  return { key: getEnv().FAL_KEY, source: 'platform' };
}

export const falMotionProvider = {
  id: 'fal' as const,

  claim(_modelKey: ImageToVideoModel, scopedDb?: FalCredentialScopedDb) {
    return resolveFalKey(scopedDb);
  },

  async submit(options: GenerateMotionOptions, key: ResolvedApiKey) {
    const modelKey = options.model || DEFAULT_VIDEO_MODEL;
    const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

    // Locally-served /r2/ image URLs aren't reachable by real fal — swap them
    // for a fal-storage upload first (no-op in prod and e2e replay).
    const imageUrl = await ensureExternallyFetchableUrl(
      options.imageUrl,
      key.key
    );

    // Decide which endpoint this run submits to (#873). With cast/element refs,
    // models that have a dedicated reference-to-video endpoint (Seedance) route
    // there; everything else (incl. Kling, which carries refs inline as
    // `elements`) stays on its image-to-video endpoint.
    const hasReferenceImages = (options.referenceImages?.length ?? 0) > 0;
    const endpoint = resolveMotionEndpoint(modelKey, hasReferenceImages);

    // Reference images are emitted either inline (Kling's `elements`) or via the
    // reference-to-video endpoint (Seedance). Both paths need externally-fetchable
    // URLs — the same locally-served /r2/ swap as imageUrl, using the claimed
    // key so BYOK uploads work without a platform FAL_KEY (#924). Models that
    // don't emit refs keep the raw references: their URLs are never sent, but
    // the builder still needs the tokens + descriptions to substitute entity
    // tokens in the prompt.
    const emitsReferences =
      endpoint.usesReferenceEndpoint || modelKey === 'kling_v3_pro';
    const referenceImages =
      emitsReferences && options.referenceImages?.length
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

    const optionsWithFetchableUrls = { ...options, imageUrl, referenceImages };
    const modelInput = buildMotionRequest(
      optionsWithFetchableUrls,
      modelKey
    ).input;

    const { prompt: optimisedPrompt, ...modelOptions } = modelInput;
    if (typeof optimisedPrompt !== 'string') {
      throw new Error('Truncated prompt is not a string');
    }
    logger.info(`Submitting job with model: ${modelConfig.id}`, {
      provider: modelConfig.provider,
      endpoint: endpoint.endpointId,
      promptLength: optimisedPrompt.length,
      modelOptions,
    });

    // Bound submit so a hung fal connection fails the step (#826).
    const job = await generateVideo({
      adapter: falVideo(endpoint.endpointId, {
        apiKey: key.key,
      }),
      prompt: optimisedPrompt,
      modelOptions,
      timeout: FAL_REQUEST_TIMEOUT_MS,
      debug: false,
    });

    return { jobId: job.jobId };
  },

  async poll(jobId: string, modelKey: ImageToVideoModel, key: ResolvedApiKey) {
    const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

    // Bound a single status fetch — the workflow already budgets total poll
    // wall-clock across batches; this only prevents one hung HTTP call from
    // freezing a poll step forever (#826).
    return await getVideoJobStatus({
      adapter: falVideo(modelConfig.id, {
        apiKey: key.key,
        fetch: createDeadlineFetch(FAL_REQUEST_TIMEOUT_MS, 'Motion job status'),
      }),
      jobId,
    });
  },

  pricingEndpointId: falPricingEndpointId,

  async costFromUsage(usage, ctx) {
    const endpointId = falPricingEndpointId(ctx.modelKey, ctx);
    return {
      endpointId,
      unitsBilled: usage?.unitsBilled,
      cost: await falCostFromUnits(endpointId, usage?.unitsBilled),
      recordFalUsage: true,
    };
  },
} satisfies MotionProvider;
