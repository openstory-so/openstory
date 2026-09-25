/**
 * The `locationSheetWorkflow` durable workflow.

 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/billing/server/workflow-deduction';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { generateId } from '@/platform/id';
import type { ImageGenerationParams } from '@/stills/server/image-generation';
import { buildLocationSheetPrompt } from '@/cast/location-prompt';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import { getGenerationChannel } from '@/platform/realtime';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { storeGeneratedPng } from '@/stills/server/image-storage';
import { generateImageSoftening } from '@/stills/server/workflows/content-soften';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
} from '@/platform/server/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { reportParkedLocationSheet } from './sheet-divergence';
import { locationSheetHashMatchesStored } from './sheet-snapshots';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'location-sheet']);

export class LocationSheetWorkflow extends OpenStoryWorkflowEntrypoint<LocationSheetWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<LocationSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<LocationSheetWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    await step.do('validate-snapshot', async () => {
      if (input.snapshotInputHash) {
        // Accepts the pre-#1785 shape too, so a run queued before the
        // hash grew a channel does not read as tampered.
        if (
          !(await locationSheetHashMatchesStored(
            input.snapshotInputHash,
            input
          ))
        ) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      }
    });

    // Emit realtime event that generation has started
    await step.do('emit-start-event', async () => {
      if (input.sequenceId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: input.locationDbId,
            status: 'generating',
          }
        );
      }
    });

    // Step 1: Validate and build prompt
    const builtParams: ImageGenerationParams = await step.do(
      'build-prompt',
      async () => {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (!input.locationMetadata) {
          throw new WorkflowValidationError('locationMetadata is required');
        }

        const hasLibraryLocation = !!(
          input.referenceImageUrl || input.libraryLocationDescription
        );
        logger.info(
          `[LocationSheetWorkflow:cf] Starting reference generation for location ${input.locationName}${hasLibraryLocation ? ' with library location reference' : ''}`
        );

        // Build library location overrides if data is provided
        const libraryOverrides = hasLibraryLocation
          ? {
              description: input.libraryLocationDescription,
              referenceImageUrl: input.referenceImageUrl,
            }
          : undefined;

        // Build prompt with location identity + library reference + sequence style
        const { prompt, referenceUrls } = buildLocationSheetPrompt(
          input.locationMetadata,
          libraryOverrides,
          input.styleConfig
        );
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // Location reference images use landscape aspect ratio for establishing shots
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          // Use library reference image(s) for visual consistency
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
        } satisfies ImageGenerationParams;
      }
    );

    // Destination is resolved BEFORE generating, because the image is stored
    // inside the generating step (#1645). `locationDbId` and `teamId` are
    // required on the payload; `sequenceId` is optional on the shared context
    // but the trigger always sets it, and the run cannot write its row or
    // emit progress without it.
    const locationDbId = input.locationDbId;
    const teamId = input.teamId;
    const sequenceId = input.sequenceId;
    if (!sequenceId) {
      throw new WorkflowValidationError('sequenceId is required');
    }

    // Step 2: Generate the location reference image — reseeds on a content
    // flag, then one softened prompt (#1293). The upload rides the same step:
    // a via that answers with inline bytes has no URL to pass on, and the
    // whole image would otherwise ride the 1 MiB checkpoint (#1638).
    const generation = await generateImageSoftening({
      step,
      scopedDb,
      workflowRunId: event.instanceId,
      userId: input.userId,
      sequenceId: input.sequenceId,
      reservationId: input.reservationId,
      kind: 'location-sheet',
      logTag: '[LocationSheetWorkflow:cf]',
      subject: `reference for ${input.locationName}`,
      stepName: 'generate-reference-image',
      params: builtParams,
      meta: { locationDbId },
      store: (result) =>
        storeGeneratedPng(
          result.imageUrls[0],
          STORAGE_BUCKETS.LOCATIONS,
          `${teamId}/${sequenceId}/${locationDbId}/${generateId()}.png`
        ),
      onRetry: async (retry) => {
        await getGenerationChannel(sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: locationDbId,
            status: 'generating',
            phase: 'retrying',
            ...retry,
          }
        );
      },
    });
    const storageResult = generation.stored;
    const imageMetadata = generation.metadata;
    const generationParams = generation.params;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const falUsage = await recordFalUsageStep(step, scopedDb, imageMetadata);

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageMetadata),
        usedOwnKey: imageMetadata.usedOwnKey,
        description: `Location sheet (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:sheet`,
        reservationId: input.reservationId,
        metadata: {
          ...falUsage,
          model: generationParams.model,
          locationName: input.locationName,
          locationDbId,
        },
        workflowName: 'LocationSheetWorkflow',
      });
    });

    let referenceImageUrl: string = storageResult.url;
    const referenceImagePath: string = storageResult.path;
    let sheetVersionId: string | null = null;

    await step.do('record-provenance', async () => {
      await recordProvenance(scopedDb.provenance, {
        teamId,
        userId: input.userId,
        assetKind: 'location_sheet',
        assetId: locationDbId,
        storageKey: storageResult.path,
        provider: 'fal',
        model: generationParams.model,
        providerRequestId: falUsage.requestId ?? null,
        workflowRunId,
        prompt: generationParams.prompt,
        sequenceId,
        referenceImageCount: generationParams.referenceImageUrls?.length ?? 0,
      });
    });

    // Step 4: Land through the claim (#1113) — see the character twin.
    // A run queued before #1113 carries no claim and lands unconditionally.
    const reconcileOutcome = await step.do(
      'reconcile-database',
      async (): Promise<
        { kind: 'convergent'; versionId: string | null } | { kind: 'divergent' }
      > => {
        const versionId = input.referenceVersionId;
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        if (!versionId) {
          const location = await scopedDb.sequenceLocations.updateReference(
            locationDbId,
            storageResult.url,
            storageResult.path,
            input.snapshotInputHash ?? null,
            { model: generationParams.model, workflowRunId }
          );
          return {
            kind: 'convergent',
            versionId: location.selectedReferenceVersionId,
          };
        }
        const landing = await scopedDb.locationSheetVariants.promoteIfPending({
          locationId: locationDbId,
          versionId,
          url: storageResult.url,
          storagePath: storageResult.path,
          inputHash: input.snapshotInputHash ?? null,
          model: generationParams.model,
          workflowRunId,
        });
        if (landing === 'promoted') return { kind: 'convergent', versionId };
        logger.warn('[LocationSheetWorkflow:cf] claim moved; sheet parked', {
          locationDbId,
          versionId,
          storagePath: storageResult.path,
        });
        await reportParkedLocationSheet({
          sequenceId,
          locationId: locationDbId,
          versionId,
          snapshotInputHash: input.snapshotInputHash,
        });
        return { kind: 'divergent' };
      }
    );
    if (reconcileOutcome.kind === 'convergent') {
      sheetVersionId = reconcileOutcome.versionId;
    }

    if (reconcileOutcome.kind === 'divergent') {
      // `stale:detected` is out and the land batch settled the status
      // unless a newer run holds the claim — see the character twin.
      await step.do('settle-divergent-status', async () => {
        await getGenerationChannel(sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: locationDbId,
            status: 'completed',
          }
        );
      });
      logger.info(
        `[LocationSheetWorkflow:cf] Diverged for ${input.locationName}; saved as variant`
      );
      return {
        referenceImageUrl,
        referenceImagePath,
        locationDbId,
        diverged: true,
      };
    }

    // Emit realtime event that generation is complete
    await step.do('emit-complete-event', async () => {
      await getGenerationChannel(sequenceId).emit(
        'generation.location-sheet:progress',
        {
          locationId: locationDbId,
          status: 'completed',
          referenceImageUrl,
        }
      );
    });

    logger.info(
      `[LocationSheetWorkflow:cf] Location reference workflow completed for ${input.locationName}`
    );

    const result: LocationSheetWorkflowResult = {
      referenceImageUrl,
      referenceImagePath,
      locationDbId,
      sheetVersionId,
    };

    return result;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<LocationSheetWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // Mark location reference as failed — through the claim (#1113).
    if (input.locationDbId && input.teamId) {
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
      if (input.referenceVersionId) {
        await scopedDb.sequenceLocations.failReferenceClaim(
          input.locationDbId,
          input.referenceVersionId,
          error
        );
      } else {
        await scopedDb.sequenceLocations.updateReferenceStatus(
          input.locationDbId,
          'failed',
          error
        );
      }

      // Emit failure event for realtime UI update
      if (input.sequenceId) {
        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.location-sheet:progress',
            {
              locationId: input.locationDbId,
              status: 'failed',
              error,
            }
          );
        } catch (emitError) {
          logger.error(
            `[LocationSheetWorkflow:cf] Failed to emit failure event for sequence ${input.sequenceId} location ${input.locationDbId}:`,
            {
              err: emitError,
            }
          );
        }
      }

      logger.error(
        `[LocationSheetWorkflow:cf] Reference generation failed for location ${input.locationName}: ${error}`
      );
    }
  }
}
