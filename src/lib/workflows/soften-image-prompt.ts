/**
 * Content-rejection handling for shot stills (#1272).
 *
 * Same-prompt reseeds (#881) stay first: stochastic checker hits often clear
 * on a fresh seed. When they don't, swap to Grok Imagine 2 on the original
 * prompt + refs (a new `kind: 'model'` variant — the selected model's row
 * stays failed). If Grok also flags, rewrite the prompt (policy soften and/or
 * plainer grammar) and generate once more on Grok. One soften pass bounds the
 * loop — a second content hit fails the run with the real rejection. Already
 * on Grok Imagine 2 skips the swap and softens in place.
 */

import {
  CONTENT_REJECTION_FALLBACK_EVENT,
  CONTENT_REJECTION_RETRY_EVENT,
  CONTENT_REJECTION_SOFTEN_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { IMAGE_MODELS, type TextToImageModel } from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
  type ImageGenerationResult,
} from '@/lib/image/image-generation';
import { getLogger } from '@/lib/observability/logger';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import type { ImageWorkflowInput } from '@/lib/workflow/types';
import {
  IMAGE_CONTENT_FALLBACK_MODEL,
  softenRejectedImagePrompt,
} from '@/lib/workflows/content-soften';
import { computeShotImageSceneHash } from '@/lib/workflows/sheet-snapshots';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'image', 'soften']);

/**
 * Same-prompt reseeds on the selected model before we swap or rewrite
 * (#881). Matches motion / character sheet.
 */
const MAX_IMAGE_ATTEMPTS = 3;

export type GenerateImageWithContentRetryResult = {
  result: ImageGenerationResult;
  params: ImageGenerationParams;
  /** Authored prompt actually rendered (not the Image-N enhanced form). */
  prompt: string;
  /**
   * Hash to stamp on the completed variant. Original unless we swapped model
   * or softened, in which case it is recomputed so the still does not
   * immediately read stale against the selected version.
   */
  snapshotInputHash: string | null;
  /**
   * `frame_variants` row this result should complete. The prep claim unless
   * we swapped to Grok, in which case it is the appended fallback row.
   */
  versionId: string;
};

type GenerateArgs = {
  step: WorkflowStep;
  scopedDb: WorkflowScopedDb;
  workflowRunId: string;
  input: ImageWorkflowInput;
  params: ImageGenerationParams;
  versionId: string;
  snapshotInputHash: string | null;
};

type GenerateOutcome =
  | { ok: true; result: ImageGenerationResult }
  | { ok: false; rejection: string };

function analysisModelFor(stored: string | null | undefined): AnalysisModelId {
  return getAnalysisModelById(stored ?? '')?.id ?? DEFAULT_ANALYSIS_MODEL;
}

function rebuildParams(
  input: ImageWorkflowInput,
  params: ImageGenerationParams,
  prompt: string
): ImageGenerationParams {
  const { prompt: enhancedPrompt, referenceUrls } = buildReferenceImagePrompt(
    prompt,
    input.referenceImages ?? [],
    IMAGE_MODELS[params.model].maxPromptLength
  );
  return {
    ...params,
    prompt: enhancedPrompt,
    referenceImageUrls: referenceUrls.length > 0 ? referenceUrls : undefined,
  };
}

type PromptProvenance = {
  inputHash: string | null;
  analysisModel: string | null;
};

async function loadPromptProvenance(
  step: WorkflowStep,
  scopedDb: WorkflowScopedDb,
  input: ImageWorkflowInput
): Promise<PromptProvenance> {
  return step.do(
    'load-prompt-provenance',
    async (): Promise<PromptProvenance> => {
      if (!input.frameId || !input.promptVersionId) {
        return { inputHash: null, analysisModel: null };
      }
      const original =
        await scopedDb.claims.framePromptVersions.getByIdForFrame(
          input.promptVersionId,
          input.frameId
        );
      return {
        inputHash: original?.inputHash ?? null,
        analysisModel: original?.analysisModel ?? null,
      };
    }
  );
}

/**
 * Append a `softened` prompt version (mirrors onto the frame) and stamp the
 * in-flight still so selecting it restores the text that produced it.
 */
export async function persistSoftenedPromptVersion(args: {
  scopedDb: WorkflowScopedDb;
  frameId: string;
  text: string;
  provenance: PromptProvenance;
  versionId: string;
  createdBy: string;
}): Promise<{ id: string }> {
  const version = await args.scopedDb.framePromptVersions.write({
    frameId: args.frameId,
    text: args.text,
    source: 'softened',
    inputHash: args.provenance.inputHash,
    analysisModel: args.provenance.analysisModel,
    createdBy: args.createdBy,
  });

  if (args.versionId) {
    await args.scopedDb.frameVariants.update(args.versionId, {
      promptVersionId: version.id,
    });
  }

  return { id: version.id };
}

async function generateOnce(
  step: WorkflowStep,
  stepName: string,
  args: GenerateArgs,
  params: ImageGenerationParams,
  attempt: number,
  maxAttempts: number
): Promise<GenerateOutcome> {
  const { input, scopedDb } = args;
  return step.do(stepName, async (): Promise<GenerateOutcome> => {
    logger.info(
      `[ImageWorkflow] Generating image ${input.shotId} with model ${params.model} (attempt ${attempt}/${maxAttempts})`
    );
    if (attempt > 1 && input.shotId && input.sequenceId) {
      await getGenerationChannel(input.sequenceId).emit(
        'generation.image:progress',
        {
          shotId: input.shotId,
          status: 'generating',
          phase: 'retrying',
          attempt,
          maxAttempts,
          model: params.model,
          variantOnly: input.variantOnly,
        }
      );
    }
    try {
      const result = await generateImageWithProvider(params, {
        scopedDb: scopedDb.credentials,
        observability: {
          observationName: 'shot-image',
          tags: ['image'],
          userId: input.userId,
          sessionId: input.sequenceId,
          metadata: {
            shotId: input.shotId,
            model: params.model,
            attempt,
          },
        },
      });
      return { ok: true, result };
    } catch (error) {
      if (isContentRejectionError(error)) {
        return { ok: false, rejection: extractFalErrorMessage(error) };
      }
      throw error;
    }
  });
}

async function recomputeSnapshotHash(
  step: WorkflowStep,
  stepName: string,
  input: ImageWorkflowInput,
  visualPrompt: string,
  model: TextToImageModel,
  current: string | null
): Promise<string | null> {
  if (!input.sceneSnapshot || !input.aspectRatio) return current;
  const sceneSnapshot = input.sceneSnapshot;
  const aspectRatio = input.aspectRatio;
  return step.do(stepName, async () =>
    computeShotImageSceneHash(
      { ...sceneSnapshot, visualPrompt },
      model,
      aspectRatio
    )
  );
}

export async function generateImageWithContentRetry(
  args: GenerateArgs
): Promise<GenerateImageWithContentRetryResult> {
  const { step, scopedDb, input, workflowRunId } = args;
  let params = args.params;
  let prompt = input.prompt;
  let snapshotInputHash = args.snapshotInputHash;
  let versionId = args.versionId;
  const canFallback = params.model !== IMAGE_CONTENT_FALLBACK_MODEL;
  const maxAttempts = MAX_IMAGE_ATTEMPTS + (canFallback ? 1 : 0) + 1;

  let lastRejection: string | null = null;
  let result: ImageGenerationResult | null = null;

  for (let attempt = 0; attempt < MAX_IMAGE_ATTEMPTS; attempt++) {
    const tag = attempt === 0 ? '' : `-retry-${attempt}`;
    const outcome = await generateOnce(
      step,
      `generate-image${tag}`,
      args,
      params,
      attempt + 1,
      maxAttempts
    );
    if (outcome.ok) {
      result = outcome.result;
      if (attempt > 0) {
        logger.info(
          `[ImageWorkflow] content-flag retry rescued frame ${input.shotId} on attempt ${attempt + 1}`,
          {
            event: CONTENT_REJECTION_RETRY_EVENT,
            outcome: 'rescued',
            kind: 'image',
            model: params.model,
            attempts: attempt + 1,
            shotId: input.shotId,
            sequenceId: input.sequenceId,
          }
        );
      }
      break;
    }
    lastRejection = outcome.rejection;
    logger.warn(
      `[ImageWorkflow] content-flag rejection on attempt ${attempt + 1}/${MAX_IMAGE_ATTEMPTS} for shot ${input.shotId}: ${outcome.rejection}`
    );
  }

  if (!result && lastRejection && canFallback) {
    const selectedModel = params.model;
    logger.warn(
      `[ImageWorkflow] same-prompt reseeds exhausted; falling back to ${IMAGE_CONTENT_FALLBACK_MODEL} for shot ${input.shotId}`,
      {
        event: CONTENT_REJECTION_FALLBACK_EVENT,
        kind: 'image',
        fromModel: selectedModel,
        model: IMAGE_CONTENT_FALLBACK_MODEL,
        shotId: input.shotId,
        sequenceId: input.sequenceId,
        rejection: lastRejection,
      }
    );

    params = rebuildParams(
      input,
      { ...params, model: IMAGE_CONTENT_FALLBACK_MODEL },
      prompt
    );
    snapshotInputHash = await recomputeSnapshotHash(
      step,
      'hash-fallback-snapshot',
      input,
      prompt,
      IMAGE_CONTENT_FALLBACK_MODEL,
      snapshotInputHash
    );

    const frameId = input.frameId;
    const sequenceId = input.sequenceId;
    if (frameId && sequenceId && versionId && !input.skipStorage) {
      const originalVersionId = versionId;
      const originalRejection = lastRejection;
      const fallbackHash = snapshotInputHash;
      versionId = await step.do('switch-to-fallback-model', async () => {
        await scopedDb.frameVariants.update(originalVersionId, {
          status: 'failed',
          error: originalRejection,
        });
        const fallbackVersion = await scopedDb.frameVariants.appendVersion({
          frameId,
          sequenceId,
          kind: 'model',
          model: IMAGE_CONTENT_FALLBACK_MODEL,
          status: 'generating',
          workflowRunId,
          promptVersionId: input.promptVersionId ?? null,
          pendingInputHash: fallbackHash,
        });
        if (!input.variantOnly) {
          await scopedDb.frames.setPendingPromoteVersionId(
            frameId,
            fallbackVersion.id
          );
        }
        if (input.shotId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              modelFallback: true,
              model: IMAGE_CONTENT_FALLBACK_MODEL,
              variantOnly: input.variantOnly,
            }
          );
        }
        return fallbackVersion.id;
      });
    }

    const outcome = await generateOnce(
      step,
      'generate-image-fallback',
      args,
      params,
      MAX_IMAGE_ATTEMPTS + 1,
      maxAttempts
    );
    if (outcome.ok) {
      result = outcome.result;
      logger.info(
        `[ImageWorkflow] fallback model rescued frame ${input.shotId}`,
        {
          event: CONTENT_REJECTION_FALLBACK_EVENT,
          outcome: 'rescued',
          kind: 'image',
          fromModel: selectedModel,
          model: IMAGE_CONTENT_FALLBACK_MODEL,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
        }
      );
    } else {
      lastRejection = outcome.rejection;
      logger.warn(
        `[ImageWorkflow] fallback model also flagged for shot ${input.shotId}: ${outcome.rejection}`
      );
    }
  }

  if (!result && lastRejection) {
    logger.warn(
      `[ImageWorkflow] ${canFallback ? 'fallback flagged' : 'same-prompt reseeds exhausted'}; softening prompt for shot ${input.shotId}`,
      {
        event: CONTENT_REJECTION_SOFTEN_EVENT,
        kind: 'image',
        model: params.model,
        shotId: input.shotId,
        sequenceId: input.sequenceId,
        rejection: lastRejection,
      }
    );

    const provenance = await loadPromptProvenance(step, scopedDb, input);

    let softened: string;
    try {
      softened = await softenRejectedImagePrompt(step, {
        scopedDb,
        workflowRunId,
        sequenceId: input.sequenceId,
        userId: input.userId,
        prompt,
        rejection: lastRejection,
        analysisModelId: analysisModelFor(provenance.analysisModel),
        shotId: input.shotId,
        model: params.model,
        reservationId: input.reservationId,
      });
    } catch (error) {
      logger.warn(
        `[ImageWorkflow] failed to soften prompt for shot ${input.shotId}`,
        { err: error, rejection: lastRejection }
      );
      throw new NonRetryableError(
        `Image rejected by content filter after ${MAX_IMAGE_ATTEMPTS} attempts: ${lastRejection}`,
        'ContentRejectionExhausted'
      );
    }

    const frameId = input.frameId;
    if (frameId && !input.skipStorage) {
      await step.do('write-softened-prompt', async () => {
        await persistSoftenedPromptVersion({
          scopedDb,
          frameId,
          text: softened,
          provenance,
          versionId,
          createdBy: input.userId,
        });
        if (input.shotId && input.sequenceId) {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.image:progress',
            {
              shotId: input.shotId,
              status: 'generating',
              promptSoftened: true,
              model: params.model,
              variantOnly: input.variantOnly,
            }
          );
        }
      });
    }

    prompt = softened;
    params = rebuildParams(input, params, softened);
    snapshotInputHash = await recomputeSnapshotHash(
      step,
      'hash-softened-snapshot',
      input,
      softened,
      params.model,
      snapshotInputHash
    );

    const outcome = await generateOnce(
      step,
      'generate-image-softened',
      args,
      params,
      maxAttempts,
      maxAttempts
    );
    if (outcome.ok) {
      result = outcome.result;
      logger.info(
        `[ImageWorkflow] softened prompt rescued frame ${input.shotId}`,
        {
          event: CONTENT_REJECTION_SOFTEN_EVENT,
          outcome: 'rescued',
          kind: 'image',
          model: params.model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
        }
      );
    } else {
      lastRejection = outcome.rejection;
      logger.error(
        `[ImageWorkflow] content-flag retry exhausted for shot ${input.shotId} after soften`,
        {
          event: CONTENT_REJECTION_RETRY_EVENT,
          outcome: 'exhausted',
          kind: 'image',
          model: params.model,
          attempts: maxAttempts,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
          rejection: lastRejection,
        }
      );
      throw new NonRetryableError(
        `Image rejected by content filter after ${MAX_IMAGE_ATTEMPTS} attempts and a softened prompt: ${lastRejection}`,
        'ContentRejectionExhausted'
      );
    }
  }

  if (!result) {
    throw new NonRetryableError(
      `Image rejected by content filter after ${MAX_IMAGE_ATTEMPTS} attempts: ${lastRejection ?? 'unknown rejection'}`,
      'ContentRejectionExhausted'
    );
  }

  return { result, params, prompt, snapshotInputHash, versionId };
}
