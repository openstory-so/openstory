import { getEnv } from '#env';
import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { FAL_GENERATION_TIMEOUT_MS } from '@/lib/ai/fal-deadline-fetch';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { type Microdollars } from '@/lib/billing/money';
import type { CredentialScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import { buildImageRequest } from '@/lib/image/build-image-request';
import type { MediaVia } from '@/lib/ai/via';
import {
  recordMediaGenerationSpan,
  type AIObservabilityMeta,
} from '@/lib/observability/ai-otel';
import { ensureExternallyFetchableUrls } from '@/lib/storage/external-url';
import { generateImage } from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';

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
  let via: MediaVia = 'fal';

  try {
    const result = await generateImageInternal(params, options);
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

async function generateImageInternal(
  rawParams: ImageGenerationParams,
  options?: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  // Native PRs try their key first (resolveOptionalKey) and switch via.
  // Fal is the fallback and always claims.
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
  const { via, endpointId: endpoint, input } = buildImageRequest(params);
  const { prompt, ...modelOptions } = input;

  let result;
  // Native PRs widen MediaVia; this switch is the seam (#1216).
  switch (via) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    case 'fal':
      // Bound so a hung fal.subscribe fails the workflow step and CF can retry
      // (#826). Native activity `timeout` since @tanstack/ai@0.44 / ai-fal@0.10.
      result = await generateImage({
        adapter: falImage(endpoint, { apiKey: key.key }),
        prompt,
        modelOptions,
        timeout: FAL_GENERATION_TIMEOUT_MS,
        debug: false,
      });
      break;
  }

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
