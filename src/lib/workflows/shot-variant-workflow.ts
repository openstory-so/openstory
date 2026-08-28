/**
 * Shot variant (3×3 grid) workflow — generates the composition-picker SHEET.
 *
 * #989: the sheet is no longer a `shots.variantImageUrl` column. It is a
 * `frame_variants` version with `kind:'framing'` and `sourceVariantId = NULL`
 * (the raw grid; a chosen tile later points its `sourceVariantId` at this
 * sheet). The picker reads the latest such version. The sheet is never
 * "selected" — it's only the source the tiles are cropped from.
 */

import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import {
  DEFAULT_IMAGE_SIZE,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/image-generation';
import { recordProvenance } from '@/lib/compliance/provenance';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { r2KeyFromUrl } from '@/lib/storage/buckets';
import {
  buildReferenceImagePrompt,
  type ReferenceImageDescription,
} from '@/lib/prompts/reference-image-prompt';
import { getVariantImagePrompt } from '@/lib/prompts/variant-image';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { generateImageSoftening } from '@/lib/workflows/content-soften';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  ShotVariantWorkflowInput,
  ShotVariantWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'shot-variant']);

type PrepResult = {
  params: ImageGenerationParams;
  versionId: string;
  /** Authored grid prompt (pre-legend) — what a content soften rewrites. */
  basePrompt: string;
  references: ReferenceImageDescription[];
};

export class ShotVariantWorkflow extends OpenStoryWorkflowEntrypoint<ShotVariantWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ShotVariantWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<ShotVariantWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    const prep = await step.do(
      'set-generating-status',
      async (): Promise<PrepResult | null> => {
        if (!input.thumbnailUrl || input.thumbnailUrl.trim().length === 0) {
          throw new WorkflowValidationError(
            'Source still URL is required for variant grid generation'
          );
        }

        logger.info(
          `[ShotVariantWorkflow] Starting variant grid generation for user ${input.userId}`
        );

        const model = input.model || DEFAULT_IMAGE_MODEL;
        const gridConfig = input.aspectRatio
          ? getVariantGridConfig(input.aspectRatio)
          : null;
        const imageSize =
          gridConfig?.imageSize ?? input.imageSize ?? DEFAULT_IMAGE_SIZE;

        const basePrompt = getVariantImagePrompt(
          imageSize,
          input.scenePrompt,
          gridConfig
            ? { cols: gridConfig.cols, rows: gridConfig.rows }
            : undefined
        );

        const allReferences: ReferenceImageDescription[] = [
          {
            referenceImageUrl: input.thumbnailUrl,
            description: `Primary source scene — generate ${gridConfig?.count ?? 9} variant shots from this image`,
            role: 'primary',
          },
          ...(input.characterReferences ?? []),
          ...(input.locationReferences ?? []),
          ...(input.elementReferences ?? []),
        ];

        const { prompt: enhancedPrompt, referenceUrls } =
          buildReferenceImagePrompt(
            basePrompt,
            allReferences,
            IMAGE_MODELS[model].maxPromptLength
          );

        const params: ImageGenerationParams = {
          model,
          prompt: enhancedPrompt,
          imageSize,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls: referenceUrls,
        };

        // No frame to attach the sheet to → generate the grid but skip the
        // version write. `frameId` is absent only when the spawner had no shot
        // to match (shot-images on a scene with no shot), which the `shotId`
        // half of this guard already covers; resolving the anchor here instead
        // would re-read a pointer the spawn never saw.
        if (!input.shotId || !input.sequenceId || !input.frameId) {
          return {
            params,
            versionId: '',
            basePrompt,
            references: allReferences,
          };
        }
        // The trigger's frame (frame id ≠ shot id), checked for existence only.
        const frame = await scopedDb.liveRead.frames.getById(input.frameId);
        if (!frame) {
          logger.info(
            `[ShotVariantWorkflow] Frame ${input.frameId} was deleted, skipping the sheet write for shot ${input.shotId}`
          );
          return null;
        }

        const version = await scopedDb.frameVariants.appendVersion({
          frameId: frame.id,
          sequenceId: input.sequenceId,
          kind: 'framing',
          model,
          sourceVariantId: null,
          // Provenance only — the sheet is never selected, but its tiles
          // inherit which prompt the grid was generated from (#1070).
          promptVersionId: input.promptVersionId ?? null,
          status: 'generating',
          workflowRunId,
        });

        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          { shotId: input.shotId, status: 'generating' }
        );

        return {
          params,
          versionId: version.id,
          basePrompt,
          references: allReferences,
        };
      }
    );

    if (!prep) {
      return { variantImageUrl: '' };
    }

    // Reseeds on a content flag, then one softened prompt rebuilt with the
    // same reference legend (#1293).
    const generation = await generateImageSoftening({
      step,
      scopedDb,
      workflowRunId,
      userId: input.userId,
      sequenceId: input.sequenceId,
      kind: 'variant-grid',
      logTag: '[ShotVariantWorkflow]',
      subject: `variant grid ${input.shotId}`,
      stepName: 'generate-image',
      params: prep.params,
      prompt: prep.basePrompt,
      rebuild: (nextPrompt, model) => {
        const rebuilt = buildReferenceImagePrompt(
          nextPrompt,
          prep.references,
          IMAGE_MODELS[model].maxPromptLength
        );
        return {
          ...prep.params,
          model,
          prompt: rebuilt.prompt,
          referenceImageUrls: rebuilt.referenceUrls,
        };
      },
      meta: { shotId: input.shotId },
    });
    const imageResult = generation.result;

    // Before the deduction guard — see recordFalUsageStep (#1069). Native
    // xAI images have no fal units; sampling them would corrupt fal medians.
    const falUsage: { requestId?: string } =
      imageResult.via === 'fal'
        ? await recordFalUsageStep(step, scopedDb, imageResult.metadata)
        : {};

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Variant grid generation (${prep.params.model})`,
        idempotencyKey: `${event.instanceId}:variant-image`,
        metadata: {
          ...falUsage,
          model: prep.params.model,
          shotId: input.shotId,
          sequenceId: input.sequenceId,
        },
        workflowName: 'ShotVariantWorkflow',
      });
    });

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }
    let imageUrl: string = generatedImageUrl;

    if (input.shotId && input.sequenceId && input.teamId && prep.versionId) {
      const uploadResult = await step.do('upload-to-storage', async () => {
        if (!input.shotId || !input.sequenceId || !input.teamId) {
          throw new Error('Missing required IDs for storage upload');
        }
        const result = await uploadImageToStorage({
          imageUrl: generatedImageUrl,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          shotId: input.shotId,
        });
        if (!result.url) {
          throw new Error('Failed to upload image to storage');
        }

        // Complete the framing-sheet version. No selection — the sheet is the
        // picker source, not the frame's primary still.
        await scopedDb.frameVariants.update(prep.versionId, {
          status: 'completed',
          url: result.url,
          storagePath: result.path || null,
          generatedAt: new Date(),
          error: null,
        });

        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          {
            shotId: input.shotId,
            status: 'completed',
            variantImageUrl: result.url,
          }
        );

        logger.info(
          `[ShotVariantWorkflow] Grid sheet uploaded: ${result.path}`
        );
        return { url: result.url };
      });

      if (uploadResult.url) imageUrl = uploadResult.url;

      // Provenance (#1180). The 3×3 grid is a frame_variant (`kind: framing`)
      // — not the retired `shot_variants` table. storageKey is derived from
      // the cached upload URL so this step stays replay-safe if `upload-to-storage`
      // already completed with `{ url }` only.
      await step.do('record-provenance', async () => {
        const storageKey = r2KeyFromUrl(uploadResult.url);
        if (!storageKey) {
          throw new Error(`Uploaded grid for ${prep.versionId} has no R2 key`);
        }
        await recordProvenance(scopedDb.provenance, {
          teamId: input.teamId,
          userId: input.userId,
          assetKind: 'frame_variant',
          assetId: prep.versionId,
          storageKey,
          provider: imageResult.via,
          model: prep.params.model,
          providerRequestId:
            falUsage.requestId ?? imageResult.metadata.requestId ?? null,
          workflowRunId,
          prompt: prep.params.prompt,
          sequenceId: input.sequenceId,
          shotId: input.shotId,
          referenceImageCount: prep.params.referenceImageUrls?.length ?? 0,
        });
      });
    }

    return { variantImageUrl: imageUrl };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ShotVariantWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;
    if (!input.shotId || !input.teamId) return;

    await scopedDb.frameVariants.markFailedByWorkflowRun(
      event.instanceId,
      error
    );

    if (input.sequenceId) {
      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          { shotId: input.shotId, status: 'failed' }
        );
      } catch {
        // Ignore emit errors
      }
    }

    logger.error(
      `[ShotVariantWorkflow] Variant grid generation failed for shot ${input.shotId}: ${error}`
    );
  }
}
