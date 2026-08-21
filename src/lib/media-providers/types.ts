/**
 * Media-provider seam (#1216).
 *
 * One module per provider; the orchestrator (`submitMotionJob` /
 * `generateImageWithProvider`) claims through an ordered registry and stamps
 * the winner on the job so poll follows the submission. Job ids are
 * provider-scoped — re-deciding at poll time sends a fal id to xAI (or the
 * reverse) if a key appears or disappears mid-run.
 *
 * Native providers (xAI, OpenAI, BytePlus) prepend themselves to the registry
 * when those modules land. Fal is last and always claims.
 */

import type { ImageToVideoModel, TextToImageModel } from '@/lib/ai/models';
import type { Microdollars } from '@/lib/billing/money';
import type { ResolvedApiKey } from '@/lib/db/scoped/api-keys';
import type { FalCredentialScopedDb } from '@/lib/db/scoped-workflow';
import type {
  ImageGenerationOptions,
  ImageGenerationParams,
  ImageGenerationResult,
} from '@/lib/image/image-generation';
import type { GenerateMotionOptions } from '@/lib/motion/motion-generation';
import type { TokenUsage } from '@tanstack/ai';

/** Usage bag from `getVideoJobStatus` / `generateImage`. Providers read the
 *  fields they understand (`unitsBilled` for fal, `cost` for xAI, `totalTokens`
 *  for BytePlus) and ignore the rest. */
export type ProviderUsage = TokenUsage;

type MotionBilling = {
  /** Pricing key `unitsBilled` multiplies — fal endpoint id, Ark model id, … */
  endpointId: string;
  unitsBilled?: number;
  cost: Microdollars;
  /** Persist a `model_usage_observations` sample for the fal pricing cron.
   *  Native providers whose units would corrupt a fal median return false. */
  recordFalUsage: boolean;
};

type MotionSubmitResult = { jobId: string };

type MotionJobStatus = {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress?: number;
  url?: string;
  error?: string;
  usage?: ProviderUsage;
};

type MotionCostContext = {
  modelKey: ImageToVideoModel;
  hasReferenceImages: boolean;
};

export interface MotionProvider {
  readonly id: string;
  /**
   * Return a key if this provider wants `modelKey`. `undefined` skips to the
   * next entry. Fal always claims (and throws if no fal key exists).
   */
  claim(
    modelKey: ImageToVideoModel,
    scopedDb?: FalCredentialScopedDb
  ): Promise<ResolvedApiKey | undefined>;
  /** Provider owns request building, URL prep, and retry policy. */
  submit(
    options: GenerateMotionOptions,
    key: ResolvedApiKey
  ): Promise<MotionSubmitResult>;
  poll(
    jobId: string,
    modelKey: ImageToVideoModel,
    key: ResolvedApiKey
  ): Promise<MotionJobStatus>;
  pricingEndpointId(
    modelKey: ImageToVideoModel,
    ctx: { hasReferenceImages: boolean }
  ): string;
  costFromUsage(
    usage: ProviderUsage | undefined,
    ctx: MotionCostContext
  ): Promise<MotionBilling>;
}

export interface ImageProvider {
  readonly id: string;
  claim(
    modelKey: TextToImageModel,
    scopedDb?: FalCredentialScopedDb
  ): Promise<ResolvedApiKey | undefined>;
  generate(
    params: ImageGenerationParams,
    key: ResolvedApiKey,
    options?: ImageGenerationOptions
  ): Promise<ImageGenerationResult>;
}
