/**
 * The `libraryLocationSheetWorkflow` durable workflow.
 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/billing/server/workflow-deduction';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { ImageGenerationParams } from '@/stills/server/image-generation';
import {
  buildLibraryLocationSheetPrompt,
  buildLocationPreviewPrompt,
} from '@/cast/location-prompt';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import { getLocationChannel } from '@/platform/realtime';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { storeGeneratedPng } from '@/stills/server/image-storage';
import { generateImageSoftening } from '@/stills/server/workflows/content-soften';
import type {
  LibraryLocationSheetWorkflowInput,
  LibraryLocationSheetWorkflowResult,
} from '@/platform/server/workflow/types';
import { saveDivergentLibraryLocationSheet } from './sheet-divergence';
import { computeLibraryLocationSheetHashFromDto } from './sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

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
      store: (result) =>
        storeGeneratedPng(
          result.imageUrls[0],
          STORAGE_BUCKETS.LOCATIONS,
          `${input.teamId}/${input.sequenceId}/${input.locationDbId}/sheet_${generateId()}.png`
        ),
    });
    const storageResult = sheetGeneration.stored;
    const imageMetadata = sheetGeneration.metadata;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const sheetUsage = await recordFalUsageStep(
      step,
      scopedDb,
      imageMetadata,
      'record-fal-usage-sheet'
    );

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits-sheet', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageMetadata),
        usedOwnKey: imageMetadata.usedOwnKey,
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
      store: (result) =>
        storeGeneratedPng(
          result.imageUrls[0],
          STORAGE_BUCKETS.LOCATIONS,
          // Unique per run: a fixed name let a run that later parks overwrite
          // the bytes behind the live reference's URL.
          `${input.teamId}/${input.sequenceId}/${input.locationDbId}/preview_${generateId()}.png`
        ),
    });
    const previewStorageResult = previewGeneration.stored;
    const previewMetadata = previewGeneration.metadata;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const previewUsage = await recordFalUsageStep(
      step,
      scopedDb,
      previewMetadata,
      'record-fal-usage-preview'
    );

    // Deduct credits for preview generation
    await step.do('deduct-credits-preview', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(previewMetadata),
        usedOwnKey: previewMetadata.usedOwnKey,
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
    // write that opens `waitForLocationReferences`' gate. Through the claim
    // (#1113): if the location was renamed/re-described, or a newer run or the
    // user's pick took the reference while this run was in flight, the preview
    // is parked as a variant and the live reference is left alone.
    const { diverged } = await step.do(
      'update-location-preview',
      async (): Promise<{ diverged: boolean }> => {
        const claimId = input.referenceClaimId;
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        if (!claimId) {
          await scopedDb.locations.updateReference(
            input.locationDbId,
            previewStorageResult.url,
            previewStorageResult.path,
            input.snapshotInputHash
          );
          return { diverged: false };
        }
        const snapshotHash =
          input.snapshotInputHash ??
          (await computeLibraryLocationSheetHashFromDto(input));
        const landed = await scopedDb.locations.updateReferenceIfClaimed(
          input.locationDbId,
          claimId,
          previewStorageResult.url,
          previewStorageResult.path,
          snapshotHash
        );
        if (landed) return { diverged: false };

        logger.warn('[LibraryLocationSheetWorkflow:cf] claim moved; parked', {
          locationDbId: input.locationDbId,
          storagePath: previewStorageResult.path,
        });
        await saveDivergentLibraryLocationSheet({
          scopedDb,
          libraryLocationId: input.locationDbId,
          model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
          url: previewStorageResult.url,
          storagePath: previewStorageResult.path,
          workflowRunId: event.instanceId,
          snapshotInputHash: snapshotHash,
        });
        return { diverged: true };
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
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<LibraryLocationSheetWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // Clear this run's claim only while it still holds it (#1113).
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
    if (input.referenceClaimId) {
      await scopedDb.locations.clearReferenceClaimIf(
        input.locationDbId,
        input.referenceClaimId
      );
    }

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
