import { getEnv } from '#env';
import { falCostFromUnits } from '@/lib/ai/fal-cost';
import { FAL_GENERATION_TIMEOUT_MS } from '@/lib/ai/fal-deadline-fetch';
import type { TextToImageModel } from '@/lib/ai/models';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';
import {
  buildImageRequest,
  type ImageGenerationParams,
} from '@/lib/image/build-image-request';
import type {
  ImageGenerationOptions,
  ImageGenerationResult,
} from '@/lib/image/image-generation';
import { getLogger } from '@/lib/observability/logger';
import { ensureExternallyFetchableUrls } from '@/lib/storage/external-url';
import { generateImage } from '@tanstack/ai';
import { falImage } from '@tanstack/ai-fal';
import type { ImageProvider } from './types';

const logger = getLogger(['openstory', 'image', 'image-generation']);

async function resolveFalKey(
  scopedDb?: FalCredentialScopedDb
): Promise<ResolvedApiKey> {
  // Always claims: `resolveKey('fal')` throws with no key, matching the
  // pre-seam helper. Platform-only callers (scripts) skip scopedDb.
  if (scopedDb) return scopedDb.resolveKey('fal');
  return { key: getEnv().FAL_KEY, source: 'platform' };
}

export const falImageProvider = {
  id: 'fal' as const,

  claim(_modelKey: TextToImageModel, scopedDb?: FalCredentialScopedDb) {
    return resolveFalKey(scopedDb);
  },

  async generate(
    rawParams: ImageGenerationParams,
    key: ResolvedApiKey,
    _options?: ImageGenerationOptions
  ): Promise<ImageGenerationResult> {
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
    // optimised-prompt preview so the two can never drift.
    const { endpointId: endpoint, input } = buildImageRequest(params);
    const { prompt, ...modelOptions } = input;

    const adapter = falImage(endpoint, { apiKey: key.key });

    logger.info('generateImage request', {
      data: JSON.stringify(
        {
          model: params.model,
          endpoint,
          keySource: key.source,
          prompt,
          modelOptions,
          referenceImageUrls: params.referenceImageUrls ?? [],
        },
        null,
        2
      ),
    });

    // Bound so a hung fal.subscribe fails the workflow step and CF can retry
    // (#826). Native activity `timeout` since @tanstack/ai@0.44 / ai-fal@0.10.
    const result = await generateImage({
      adapter,
      prompt,
      modelOptions,
      timeout: FAL_GENERATION_TIMEOUT_MS,
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
    const cost = await falCostFromUnits(endpoint, result.usage?.unitsBilled);

    return {
      imageUrls,
      parameters: params,
      generatedAt: new Date().toISOString(),
      processingTimeMs,
      provider: 'fal',
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
  },
} satisfies ImageProvider;
