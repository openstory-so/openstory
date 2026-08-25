/**
 * Cloudflare Workflows port of `libraryLocationSheetWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/library-location-sheet-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ImageGenerationParams } from '@/lib/image/image-generation';
import {
  buildLibraryLocationSheetPrompt,
  buildLocationPreviewPrompt,
} from '@/lib/prompts/location-prompt';
import { recordProvenance } from '@/lib/compliance/provenance';
import { getLocationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { generateImageSoftening } from '@/lib/workflows/content-soften';
import type {
  LibraryLocationSheetWorkflowInput,
  LibraryLocationSheetWorkflowResult,
} from '@/lib/workflow/types';
import {
  decideSheetDivergence,
  saveDivergentLocationSheet,
} from '@/lib/workflows/sheet-divergence';
import { computeLibraryLocationSheetHashCurrent } from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'library-location-sheet']);

export class LibraryLocationSheetWorkflow extends OpenStoryWorkflowEntrypoint<LibraryLocationSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<LibraryLocationSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<LibraryLocationSheetWorkflowResult> {
    const input = event.payload;

    // Emit generating status
    await step.do('emit-generating', async () => {
      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'generating',
        }
      );
    });

    // Step 1: Build the prompt
    const generationParams: ImageGenerationParams = await step.do(
      'build-prompt',
      async () => {
        logger.info(
          `[LibraryLocationSheetWorkflow:cf] Starting sheet generation for location ${input.locationName} with ${input.referenceImageUrls.length} reference images`
        );

        const { prompt, referenceUrls } = buildLibraryLocationSheetPrompt(
          input.locationName,
          input.locationDescription,
          input.referenceImageUrls
        );

        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // 3x3 grid in landscape format
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
        } satisfies ImageGenerationParams;
      }
    );

    // Step 2: Generate the location sheet image — reseeds on a content flag,
    // then one softened prompt (#1293).
    const sheetGeneration = await generateImageSoftening({
      step,
      scopedDb,
      workflowRunId: event.instanceId,
      userId: input.userId,
      kind: 'library-location-sheet',
      logTag: '[LibraryLocationSheetWorkflow:cf]',
      subject: `3x3 grid sheet for ${input.locationName}`,
      stepName: 'generate-sheet-image',
      params: generationParams,
      meta: { locationDbId: input.locationDbId },
    });
    const imageResult = sheetGeneration.result;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const sheetUsage = await recordFalUsageStep(
      step,
      scopedDb,
      imageResult.metadata,
      'record-fal-usage-sheet'
    );

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits-sheet', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Library location sheet (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:sheet`,
        metadata: {
          ...sheetUsage,
          model: generationParams.model,
          locationName: input.locationName,
          locationDbId: input.locationDbId,
        },
        workflowName: 'LibraryLocationSheetWorkflow',
      });
    });

    // Step 3: Upload sheet to R2 storage
    const storageResult = await step.do('upload-to-storage', async () => {
      const imageUrl = imageResult.imageUrls[0];
      if (!imageUrl) {
        throw new Error('No image URL returned from generation');
      }

      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Uploading sheet to storage for ${input.locationName}`
      );

      // Fetch and stream directly to R2
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch generated image: ${response.status}`);
      }

      // Build storage path: locations/{teamId}/{sequenceId}/{locationDbId}/sheet_{uniqueId}.png
      const uniqueId = generateId();
      const storagePath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/sheet_${uniqueId}.png`;

      const result = await uploadResponse(
        response,
        STORAGE_BUCKETS.LOCATIONS,
        storagePath,
        {
          contentType: 'image/png',
        }
      );

      return {
        url: result.publicUrl,
        path: result.path,
      };
    });

    // The 3x3 grid is an intermediate artifact, NOT a usable reference: it was
    // published to `referenceImageUrl` here and replaced by the preview ~30-60s
    // later, which is long enough for a concurrent sequence's location matching
    // to cast against a contact sheet. The location's live reference is written
    // once, at the preview step below.

    // Step 4: Generate preview establishing shot for card thumbnail
    const hasReferenceImages = input.referenceImageUrls.length > 0;
    const previewParams: ImageGenerationParams = {
      model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
      prompt: buildLocationPreviewPrompt(
        input.locationName,
        input.locationDescription,
        hasReferenceImages
      ),
      imageSize: 'landscape_16_9',
      numImages: 1,
    } satisfies ImageGenerationParams;

    if (hasReferenceImages) {
      previewParams.referenceImageUrls = input.referenceImageUrls;
    }

    const previewGeneration = await generateImageSoftening({
      step,
      scopedDb,
      workflowRunId: event.instanceId,
      userId: input.userId,
      kind: 'library-location-preview',
      logTag: '[LibraryLocationSheetWorkflow:cf]',
      subject: `preview establishing shot for ${input.locationName}`,
      stepName: 'generate-preview-image',
      params: previewParams,
      meta: { locationDbId: input.locationDbId },
    });
    const previewResult = previewGeneration.result;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const previewUsage = await recordFalUsageStep(
      step,
      scopedDb,
      previewResult.metadata,
      'record-fal-usage-preview'
    );

    // Deduct credits for preview generation
    await step.do('deduct-credits-preview', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(previewResult.metadata),
        usedOwnKey: previewResult.metadata.usedOwnKey,
        description: `Location preview (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
        idempotencyKey: `${event.instanceId}:preview`,
        metadata: {
          ...previewUsage,
          locationDbId: input.locationDbId,
          type: 'preview',
        },
        workflowName: 'LibraryLocationSheetWorkflow',
      });
    });

    const previewUrl = previewResult.imageUrls[0];
    if (!previewUrl) {
      throw new Error('No preview URL returned from generation');
    }

    // Step 5: Upload preview to R2 storage
    const previewStorageResult = await step.do(
      'upload-preview-to-storage',
      async () => {
        logger.info(
          `[LibraryLocationSheetWorkflow:cf] Uploading preview to storage for ${input.locationName}`
        );

        const response = await fetch(previewUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated preview: ${response.status}`
          );
        }

        const previewPath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/preview.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.LOCATIONS,
          previewPath,
          { contentType: 'image/png' }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      }
    );

    // Both the 3×3 grid and the preview land in R2. Record each: the grid is
    // an intermediate but still shareable object; the preview is the live
    // reference. Own steps so a retry of the publish step cannot double-insert.
    await step.do('record-grid-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId: input.teamId,
        userId: input.userId,
        assetKind: 'location_sheet',
        assetId: `${input.locationDbId}#grid`,
        storageKey: storageResult.path,
        provider: 'fal',
        model: generationParams.model,
        providerRequestId: sheetUsage.requestId ?? null,
        workflowRunId: event.instanceId,
        prompt: generationParams.prompt,
        referenceImageCount: generationParams.referenceImageUrls?.length ?? 0,
      });
    });

    await step.do('record-preview-provenance', async () => {
      const hasReferenceImages = input.referenceImageUrls.length > 0;
      await recordProvenance(scopedDb.provenance, {
        teamId: input.teamId,
        userId: input.userId,
        assetKind: 'location_sheet',
        assetId: input.locationDbId,
        storageKey: previewStorageResult.path,
        provider: 'fal',
        model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
        providerRequestId: previewUsage.requestId ?? null,
        workflowRunId: event.instanceId,
        prompt: buildLocationPreviewPrompt(
          input.locationName,
          input.locationDescription,
          hasReferenceImages
        ),
        referenceImageCount: input.referenceImageUrls.length,
      });
    });

    // Step 6: Publish the preview as the location's reference — the single
    // write that opens `waitForLocationReferences`' gate. Gated on divergence:
    // if the location was renamed/re-described while this run was in flight the
    // artifact is parked as a variant and the live reference is left alone.
    const snapshotHash = input.snapshotInputHash ?? null;
    const { diverged } = await step.do(
      'update-location-preview',
      async (): Promise<{ diverged: boolean }> => {
        const currentHash = snapshotHash
          ? await computeLibraryLocationSheetHashCurrent(
              input,
              scopedDb.liveRead
            )
          : null;
        const decision = decideSheetDivergence(snapshotHash, currentHash);

        if (decision.kind === 'divergent') {
          logger.warn('[LibraryLocationSheetWorkflow:cf] divergence detected', {
            locationDbId: input.locationDbId,
            snapshotInputHash: decision.snapshotInputHash,
            currentInputHash: decision.currentInputHash,
            storagePath: previewStorageResult.path,
          });
          await saveDivergentLocationSheet({
            scopedDb,
            parent: { type: 'library_location', id: input.locationDbId },
            model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
            url: previewStorageResult.url,
            storagePath: previewStorageResult.path,
            workflowRunId: event.instanceId,
            snapshotInputHash: decision.snapshotInputHash,
          });
          return { diverged: true };
        }

        logger.info(
          `[LibraryLocationSheetWorkflow:cf] Updating location with preview image`
        );
        await scopedDb.locations.updateReference(
          input.locationDbId,
          previewStorageResult.url,
          previewStorageResult.path,
          snapshotHash ?? undefined
        );
        return { diverged: false };
      }
    );

    // Emit completed status. On divergence the URL is omitted so a subscriber
    // reading the payload directly can't mistake the parked variant for the
    // location's live reference; the terminal status still clears the UI's
    // "generating" spinner.
    await step.do('emit-completed', async () => {
      logger.info(
        `[LibraryLocationSheetWorkflow:cf] Library location sheet workflow completed for ${input.locationName}`
      );

      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'completed',
          ...(diverged ? {} : { sheetImageUrl: storageResult.url }),
        }
      );
    });

    const result: LibraryLocationSheetWorkflowResult = {
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      previewImageUrl: previewStorageResult.url,
      previewImagePath: previewStorageResult.path,
      locationDbId: input.locationDbId,
    };

    return result;
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<LibraryLocationSheetWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    logger.error(
      `[LibraryLocationSheetWorkflow:cf] Sheet generation failed for location ${input.locationName}: ${error}`
    );

    try {
      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'failed',
          error: `Sheet generation failed: ${error}`,
        }
      );
    } catch (emitError) {
      logger.error(
        `[LibraryLocationSheetWorkflow:cf] Failed to emit failure event for location ${input.locationDbId}:`,
        {
          err: emitError,
        }
      );
    }
  }
}
