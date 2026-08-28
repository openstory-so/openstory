/**
 * Content-rejection handling shared by every image render that is not a
 * shot still (#1293): character / location / element sheets, library talent
 * and location sheets, variant grids.
 *
 * Same-prompt reseeds first (#881) — stochastic checker hits often clear on a
 * fresh seed. When they don't, render the ORIGINAL prompt once on Grok
 * Imagine 2 (its checker is more permissive, #1272; skipped when already on
 * it). If that also flags, rewrite the prompt with an LLM (policy soften
 * and/or plainer grammar) and generate once more on whichever model is
 * current. One soften pass bounds the loop; a second content hit fails the
 * run with the real rejection so the parent can name it. Transient errors
 * throw so Cloudflare retries the named generate step.
 *
 * Shot stills use `generateImageWithContentRetry` (same ladder, plus the
 * `frame_variants` row for the swap and prompt-version persistence); both
 * paths share `softenRejectedImagePrompt` and the fallback model.
 */

import { z } from 'zod';
import {
  CONTENT_REJECTION_FALLBACK_EVENT,
  CONTENT_REJECTION_RETRY_EVENT,
  CONTENT_REJECTION_SOFTEN_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import type { TextToImageModel } from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
  type ImageGenerationResult,
} from '@/lib/image/image-generation';
import { getLogger } from '@/lib/observability/logger';
import { durableLLMCallCf } from '@/lib/workflows/llm-call-helper';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'content-soften']);

/** Same-prompt reseeds before the model swap / prompt rewrite (#881). */
export const MAX_CONTENT_ATTEMPTS = 3;

/** Fallback after selected-model reseeds exhaust. Skipped when already this. */
export const IMAGE_CONTENT_FALLBACK_MODEL: TextToImageModel =
  'grok_imagine_image';

/** Plain `z.string()` — no min/max (Bedrock rejects integer bounds). */
export const softenImagePromptResponseSchema = z.object({
  prompt: z.string(),
});

export async function softenRejectedImagePrompt(
  step: WorkflowStep,
  args: {
    scopedDb: WorkflowScopedDb;
    workflowRunId: string;
    sequenceId?: string;
    userId: string;
    prompt: string;
    rejection: string;
    analysisModelId: AnalysisModelId;
    shotId?: string;
    model: string;
    reservationId?: string;
    /** Durable step name — must be unique per call within a run. */
    name?: string;
  }
): Promise<string> {
  const response = await durableLLMCallCf(
    step,
    {
      name: args.name ?? 'soften-image-prompt',
      phase: { number: 4, name: 'Softening image prompt…' },
      promptName: 'phase/soften-image-prompt-chat',
      promptVariables: {
        prompt: args.prompt,
        rejection: args.rejection,
      },
      modelId: args.analysisModelId,
      responseSchema: softenImagePromptResponseSchema,
      additionalMetadata: {
        shotId: args.shotId,
        model: args.model,
      },
    },
    {
      sequenceId: args.sequenceId,
      userId: args.userId,
      workflowRunId: args.workflowRunId,
      scopedDb: args.scopedDb,
      reservationId: args.reservationId,
    }
  );

  const softened = response.prompt.trim();
  if (!softened) {
    throw new Error('Softened prompt was empty');
  }
  if (softened === args.prompt.trim()) {
    throw new Error('Softened prompt was unchanged');
  }
  return softened;
}

export type GenerateImageSofteningArgs = {
  step: WorkflowStep;
  scopedDb: WorkflowScopedDb;
  workflowRunId: string;
  userId: string;
  sequenceId?: string;
  analysisModelId?: AnalysisModelId;
  /** Structured-log `kind`, e.g. `'character-sheet'`. */
  kind: string;
  /** Log prefix, e.g. `'[CharacterSheetWorkflow:cf]'`. */
  logTag: string;
  /** Log subject, e.g. `'character Ron Weasley'`. */
  subject: string;
  /**
   * Durable step name of the first attempt — keep the caller's historical
   * name so in-flight runs replay. Retries, the fallback and the softened
   * attempt suffix it.
   */
  stepName: string;
  params: ImageGenerationParams;
  /** Authored prompt to soften. Defaults to `params.prompt`. */
  prompt?: string;
  /**
   * Params for a (prompt, model) pair — called for the fallback swap (original
   * prompt, Grok) and the softened retry. Defaults to swapping both fields on
   * `params`; pass one when the prompt carries a model-sized reference legend.
   */
  rebuild?: (prompt: string, model: TextToImageModel) => ImageGenerationParams;
  /** Ids for structured logs. */
  meta?: Record<string, unknown>;
  reservationId?: string;
};

export type GenerateImageSofteningResult = {
  result: ImageGenerationResult;
  /** Params actually rendered — a different model and/or prompt on rescue. */
  params: ImageGenerationParams;
  softened: boolean;
};

type Outcome =
  | { ok: true; result: ImageGenerationResult }
  | { ok: false; rejection: string };

export async function generateImageSoftening(
  args: GenerateImageSofteningArgs
): Promise<GenerateImageSofteningResult> {
  const { step, scopedDb, logTag, subject, stepName } = args;
  const meta = { kind: args.kind, sequenceId: args.sequenceId, ...args.meta };
  const prompt = args.prompt ?? args.params.prompt;
  const rebuild =
    args.rebuild ??
    ((p: string, model: TextToImageModel) => ({
      ...args.params,
      prompt: p,
      model,
    }));
  const canFallback = args.params.model !== IMAGE_CONTENT_FALLBACK_MODEL;
  const maxAttempts = MAX_CONTENT_ATTEMPTS + (canFallback ? 1 : 0) + 1;

  const generateOnce = (
    name: string,
    params: ImageGenerationParams,
    attempt: number
  ) =>
    step.do(name, async (): Promise<Outcome> => {
      logger.info(
        `${logTag} Generating ${subject} with model ${params.model} (attempt ${attempt}/${maxAttempts})`
      );
      try {
        const result = await generateImageWithProvider(params, {
          scopedDb: scopedDb.credentials,
        });
        return { ok: true, result };
      } catch (error) {
        if (isContentRejectionError(error)) {
          return { ok: false, rejection: extractFalErrorMessage(error) };
        }
        throw error;
      }
    });

  let params = args.params;
  let lastRejection: string | null = null;
  for (let attempt = 0; attempt < MAX_CONTENT_ATTEMPTS; attempt++) {
    const tag = attempt === 0 ? '' : `-retry-${attempt}`;
    const outcome = await generateOnce(
      `${stepName}${tag}`,
      params,
      attempt + 1
    );
    if (outcome.ok) {
      if (attempt > 0) {
        logger.info(
          `${logTag} content-flag retry rescued ${subject} on attempt ${attempt + 1}`,
          {
            event: CONTENT_REJECTION_RETRY_EVENT,
            outcome: 'rescued',
            model: params.model,
            attempts: attempt + 1,
            ...meta,
          }
        );
      }
      return { result: outcome.result, params, softened: false };
    }
    lastRejection = outcome.rejection;
    logger.warn(
      `${logTag} content-flag rejection on attempt ${attempt + 1}/${MAX_CONTENT_ATTEMPTS} for ${subject}: ${outcome.rejection}`
    );
  }

  if (canFallback) {
    const fromModel = params.model;
    logger.warn(
      `${logTag} same-prompt reseeds exhausted; falling back to ${IMAGE_CONTENT_FALLBACK_MODEL} for ${subject}`,
      {
        event: CONTENT_REJECTION_FALLBACK_EVENT,
        fromModel,
        model: IMAGE_CONTENT_FALLBACK_MODEL,
        rejection: lastRejection,
        ...meta,
      }
    );
    params = rebuild(prompt, IMAGE_CONTENT_FALLBACK_MODEL);
    const outcome = await generateOnce(
      `${stepName}-fallback`,
      params,
      MAX_CONTENT_ATTEMPTS + 1
    );
    if (outcome.ok) {
      logger.info(`${logTag} fallback model rescued ${subject}`, {
        event: CONTENT_REJECTION_FALLBACK_EVENT,
        outcome: 'rescued',
        fromModel,
        model: params.model,
        ...meta,
      });
      return { result: outcome.result, params, softened: false };
    }
    lastRejection = outcome.rejection;
    logger.warn(
      `${logTag} fallback model also flagged for ${subject}: ${outcome.rejection}`
    );
  }

  const rejection = lastRejection ?? 'unknown rejection';
  logger.warn(
    `${logTag} ${canFallback ? 'fallback flagged' : 'same-prompt reseeds exhausted'}; softening prompt for ${subject}`,
    {
      event: CONTENT_REJECTION_SOFTEN_EVENT,
      model: params.model,
      rejection,
      ...meta,
    }
  );

  let softened: string;
  try {
    softened = await softenRejectedImagePrompt(step, {
      scopedDb,
      workflowRunId: args.workflowRunId,
      sequenceId: args.sequenceId,
      userId: args.userId,
      prompt,
      rejection,
      analysisModelId: args.analysisModelId ?? DEFAULT_ANALYSIS_MODEL,
      model: params.model,
      name: `soften-${stepName}`,
      reservationId: args.reservationId,
    });
  } catch (error) {
    logger.warn(`${logTag} failed to soften prompt for ${subject}`, {
      err: error,
      rejection,
    });
    throw new NonRetryableError(
      `Image rejected by content filter after ${MAX_CONTENT_ATTEMPTS} attempts: ${rejection}`,
      'ContentRejectionExhausted'
    );
  }

  params = rebuild(softened, params.model);
  const outcome = await generateOnce(
    `${stepName}-softened`,
    params,
    maxAttempts
  );
  if (outcome.ok) {
    logger.info(`${logTag} softened prompt rescued ${subject}`, {
      event: CONTENT_REJECTION_SOFTEN_EVENT,
      outcome: 'rescued',
      model: params.model,
      ...meta,
    });
    return { result: outcome.result, params, softened: true };
  }

  logger.error(
    `${logTag} content-flag retry exhausted for ${subject} after soften`,
    {
      event: CONTENT_REJECTION_RETRY_EVENT,
      outcome: 'exhausted',
      model: params.model,
      attempts: maxAttempts,
      rejection: outcome.rejection,
      ...meta,
    }
  );
  throw new NonRetryableError(
    `Image rejected by content filter after ${MAX_CONTENT_ATTEMPTS} attempts and a softened prompt: ${outcome.rejection}`,
    'ContentRejectionExhausted'
  );
}
