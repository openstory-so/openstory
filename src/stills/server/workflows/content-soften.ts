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
} from '@/models/content-rejection';
import { extractFalErrorMessage } from '@/models/fal-error';
import type { ImageToVideoModel, TextToImageModel } from '@/models/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  type AnalysisModelId,
} from '@/models/models.config';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
  type ImageGenerationResult,
} from '@/stills/server/image-generation';
import { getLogger } from '@/platform/logger';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'content-soften']);

/** Same-prompt reseeds before the model swap / prompt rewrite (#881). */
export const MAX_CONTENT_ATTEMPTS = 3;

/** Fallback after selected-model reseeds exhaust. Skipped when already this. */
export const IMAGE_CONTENT_FALLBACK_MODEL: TextToImageModel =
  'grok_imagine_image';

/**
 * Video fallback when the STILL was flagged (#1373): checker strictness differs
 * per vendor, and a flagged input image cannot be reseeded or softened away.
 * Grok, as for images. Skipped when already this.
 */
export const MOTION_CONTENT_FALLBACK_MODEL: ImageToVideoModel =
  'grok_imagine_video_1_5';

/** Plain `z.string()` — no min/max (Bedrock rejects integer bounds). */
export const softenImagePromptResponseSchema = z.object({
  prompt: z.string(),
});

export type SoftenRejectedPromptArgs = {
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
};

export function softenRejectedImagePrompt(
  step: WorkflowStep,
  args: SoftenRejectedPromptArgs
): Promise<string> {
  return softenRejectedPrompt(step, {
    ...args,
    name: args.name ?? 'soften-image-prompt',
    promptName: 'phase/soften-image-prompt-chat',
  });
}

/** Same rewrite for an image-to-video prompt (#1373). */
export function softenRejectedMotionPrompt(
  step: WorkflowStep,
  args: SoftenRejectedPromptArgs
): Promise<string> {
  return softenRejectedPrompt(step, {
    ...args,
    name: args.name ?? 'soften-motion-prompt',
    promptName: 'phase/soften-motion-prompt-chat',
  });
}

async function softenRejectedPrompt(
  step: WorkflowStep,
  args: SoftenRejectedPromptArgs & { name: string; promptName: string }
): Promise<string> {
  const response = await durableLLMCallCf(
    step,
    {
      name: args.name,
      phase: { number: 4, name: 'Softening prompt…' },
      promptName: args.promptName,
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

export type GenerateImageSofteningArgs<S extends Record<string, string>> = {
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
  /**
   * Persist the rendered image to its final key. Runs INSIDE the generating
   * step, on purpose (#1645): a provider that answers with inline bytes has
   * no URL to hand across a step boundary, and Workflows checkpoints every
   * `step.do` result at 1 MiB — the whole image would ride it. Storing here
   * means only this small record ever crosses.
   */
  store: (result: ImageGenerationResult) => Promise<S>;
  /** Authored prompt to soften. Defaults to `params.prompt`. */
  prompt?: string;
  /**
   * Params for a (prompt, model) pair — called for the fallback swap (original
   * prompt, Grok) and the softened retry. Defaults to swapping both fields on
   * `params`; pass one when the prompt carries a model-sized reference legend.
   */
  rebuild?: (prompt: string, model: TextToImageModel) => ImageGenerationParams;
  /**
   * Called before every attempt after the first — same-prompt reseed, model
   * fallback, softened prompt — so the caller can tell the UI the spinner is
   * a retry, not a hang. Failures are swallowed: a realtime hiccup must never
   * fail the render.
   */
  onRetry?: (info: RetryInfo) => Promise<void>;
  /** Ids for structured logs. */
  meta?: Record<string, unknown>;
  reservationId?: string;
};

type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  promptSoftened: boolean;
};

export type GenerateImageSofteningResult<S extends Record<string, string>> = {
  /** What `store` returned, from inside the generating step. */
  stored: S;
  /** Provider metadata — billing, usage and provenance. Always small. */
  metadata: ImageGenerationResult['metadata'];
  /** Which API served it — fal units are only sampled for `'fal'`. */
  via: ImageGenerationResult['via'];
  /** Params actually rendered — a different model and/or prompt on rescue. */
  params: ImageGenerationParams;
  softened: boolean;
};

type Outcome<S extends Record<string, string>> =
  | {
      ok: true;
      stored: S;
      metadata: ImageGenerationResult['metadata'];
      via: ImageGenerationResult['via'];
    }
  | { ok: false; rejection: string };

export async function generateImageSoftening<S extends Record<string, string>>(
  args: GenerateImageSofteningArgs<S>
): Promise<GenerateImageSofteningResult<S>> {
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

  const announceRetry = async (attempt: number, promptSoftened: boolean) => {
    if (attempt === 1 || !args.onRetry) return;
    try {
      await args.onRetry({ attempt, maxAttempts, promptSoftened });
    } catch (error) {
      logger.warn(`${logTag} retry announce failed for ${subject}`, {
        err: error,
      });
    }
  };

  const generateOnce = async (
    name: string,
    params: ImageGenerationParams,
    attempt: number
  ): Promise<Outcome<S>> => {
    const outcome = await step.do(
      name,
      async (): Promise<Outcome<Record<string, string>>> => {
        logger.info(
          `${logTag} Generating ${subject} with model ${params.model} (attempt ${attempt}/${maxAttempts})`
        );
        try {
          const result = await generateImageWithProvider(params, {
            scopedDb: scopedDb.credentials,
          });
          // Same step, deliberately — see `store` on the args.
          const stored = await args.store(result);
          return {
            ok: true,
            stored,
            metadata: result.metadata,
            via: result.via,
          };
        } catch (error) {
          if (isContentRejectionError(error)) {
            return { ok: false, rejection: extractFalErrorMessage(error) };
          }
          throw error;
        }
      }
    );
    // `store` returned an `S`; the checkpoint round-trips it verbatim. The
    // step is typed on the concrete record because Workflows' `Serializable`
    // cannot be resolved through an unbound generic.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    return outcome as Outcome<S>;
  };

  let params = args.params;
  let lastRejection: string | null = null;
  for (let attempt = 0; attempt < MAX_CONTENT_ATTEMPTS; attempt++) {
    const tag = attempt === 0 ? '' : `-retry-${attempt}`;
    await announceRetry(attempt + 1, false);
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
      return {
        stored: outcome.stored,
        metadata: outcome.metadata,
        via: outcome.via,
        params,
        softened: false,
      };
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
    await announceRetry(MAX_CONTENT_ATTEMPTS + 1, false);
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
      return {
        stored: outcome.stored,
        metadata: outcome.metadata,
        via: outcome.via,
        params,
        softened: false,
      };
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
  await announceRetry(maxAttempts, true);
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
    return {
      stored: outcome.stored,
      metadata: outcome.metadata,
      via: outcome.via,
      params,
      softened: true,
    };
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
