import { isContentRejectionError } from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { type Microdollars } from '@/lib/billing/money';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/build-image-request';
import {
  claimImageProvider,
  type ImageProviderId,
} from '@/lib/media-providers';
import {
  recordMediaGenerationSpan,
  type AIObservabilityMeta,
} from '@/lib/observability/ai-otel';

export type { ImageGenerationParams } from '@/lib/image/build-image-request';

/** Non-serializable options passed separately from ImageGenerationParams */
export type ImageGenerationOptions = {
  scopedDb?: FalCredentialScopedDb;
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
  provider: ImageProviderId;
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

  // Claim out here, not inside generation, so the failure span can name
  // the provider that actually rejected the call.
  let providerId: ImageProviderId = 'fal';

  try {
    const { provider, key } = await claimImageProvider(
      params.model,
      options?.scopedDb
    );
    providerId = provider.id;
    const result = await provider.generate(params, key, options);
    recordMediaGenerationSpan({
      ...attribution,
      model: params.model,
      provider: result.provider,
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
      provider: providerId,
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
