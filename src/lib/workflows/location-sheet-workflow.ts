/**
 * Cloudflare Workflows port of `locationSheetWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/location-sheet-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
  recordFalUsageStep,
} from '@/lib/billing/workflow-deduction';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { generateId } from '@/lib/db/id';
import type { ImageGenerationParams } from '@/lib/image/image-generation';
import { buildLocationSheetPrompt } from '@/lib/prompts/location-prompt';
import { recordProvenance } from '@/lib/compliance/provenance';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { generateImageSoftening } from '@/lib/workflows/content-soften';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import {
  decideSheetDivergence,
  saveDivergentLocationSheet,
} from '@/lib/workflows/sheet-divergence';
import {
  computeLocationSheetHashCurrent,
  computeLocationSheetHashFromDto,
} from '@/lib/workflows/sheet-snapshots';
import { getLogger } from '@/lib/observability/logger';

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
        const expected = input.snapshotInputHash;
        const recomputed = await computeLocationSheetHashFromDto(input);
        if (recomputed !== expected) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      }
    });

    // Emit realtime event that generation has started
    await step.do('emit-start-event', async () => {
      if (input.sequenceId && input.locationDbId) {
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

    // Step 2: Generate the location reference image — reseeds on a content
    // flag, then one softened prompt (#1293).
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
      meta: { locationDbId: input.locationDbId },
    });
    const imageResult = generation.result;
    const generationParams = generation.params;

    // Before the deduction guard — see recordFalUsageStep (#1069).
    const falUsage = await recordFalUsageStep(
      step,
      scopedDb,
      imageResult.metadata
    );

    // Deduct credits for image generation (skip if team used own fal key)
    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Location sheet (${generationParams.model})`,
        idempotencyKey: `${event.instanceId}:sheet`,
        reservationId: input.reservationId,
        metadata: {
          ...falUsage,
          model: generationParams.model,
          locationName: input.locationName,
          locationDbId: input.locationDbId,
        },
        workflowName: 'LocationSheetWorkflow',
      });
    });

    const initialReferenceImageUrl = imageResult.imageUrls[0];
    if (!initialReferenceImageUrl) {
      throw new Error('Location sheet generation did not return an image URL');
    }
    let referenceImageUrl: string = initialReferenceImageUrl;
    let referenceImagePath: string | undefined = undefined;

    if (input.locationDbId && input.teamId && input.sequenceId) {
      // Capture narrowed values so inner async closures see `string`, not
      // `string | undefined`.
      const locationDbId = input.locationDbId;
      const sequenceId = input.sequenceId;
      const teamId = input.teamId;

      // Step 3: Upload to R2 storage
      const storageResult = await step.do('upload-to-storage', async () => {
        const imageUrl = imageResult.imageUrls[0];
        if (!imageUrl) {
          throw new Error('No image URL returned from generation');
        }

        logger.info(
          `[LocationSheetWorkflow:cf] Uploading reference to storage for ${input.locationName}`
        );

        // Fetch and stream directly to R2
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated image: ${response.status}`
          );
        }

        // Build storage path: locations/{teamId}/{sequenceId}/{locationDbId}/{uniqueId}.png
        const uniqueId = generateId();
        const storagePath = `${teamId}/${sequenceId}/${locationDbId}/${uniqueId}.png`;

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

      // Step 4: Divergence-aware database write. On convergent, update the
      // sequence location's primary reference. On divergent, preserve the
      // artifact as a variant row (the helper emits `stale:detected`) and
      // skip the primary update so the in-flight run does not overwrite a
      // now-stale reference.
      const snapshotInputHash = input.snapshotInputHash ?? null;
      const reconcileOutcome = await step.do(
        'reconcile-database',
        async (): Promise<{ kind: 'convergent' } | { kind: 'divergent' }> => {
          logger.info(
            `[LocationSheetWorkflow:cf] Updating database for ${input.locationName}`
          );

          const currentInputHash = snapshotInputHash
            ? await computeLocationSheetHashCurrent(input, scopedDb.liveRead)
            : null;

          const decision = decideSheetDivergence(
            snapshotInputHash,
            currentInputHash
          );

          if (decision.kind === 'divergent') {
            logger.warn('[LocationSheetWorkflow:cf] divergence detected', {
              locationDbId,
              snapshotInputHash: decision.snapshotInputHash,
              currentInputHash: decision.currentInputHash,
              storagePath: storageResult.path,
            });
            await saveDivergentLocationSheet({
              scopedDb,
              parent: {
                type: 'sequence_location',
                id: locationDbId,
                sequenceId,
              },
              model: generationParams.model,
              url: storageResult.url,
              storagePath: storageResult.path,
              workflowRunId,
              snapshotInputHash: decision.snapshotInputHash,
            });
            return { kind: 'divergent' };
          }

          await scopedDb.sequenceLocations.updateReference(
            locationDbId,
            storageResult.url,
            storageResult.path,
            snapshotInputHash
          );
          return { kind: 'convergent' };
        }
      );

      referenceImagePath = storageResult.path;
      referenceImageUrl = storageResult.url;

      if (reconcileOutcome.kind === 'divergent') {
        // Helper already emitted `stale:detected` on the sequence channel.
        // Settle the primary reference status so the UI does not stay wedged
        // on "Regenerating…". The pre-existing `referenceImageUrl` (if any)
        // remains the live primary — we deliberately did not overwrite it.
        // For first-time generation the entity ends in `completed` with a
        // null referenceImageUrl; the user can manually retry. Either way,
        // flipping status to `completed` reflects "generation finished,
        // primary unchanged, divergent variant saved alongside".
        await step.do('settle-divergent-status', async () => {
          await scopedDb.sequenceLocations.updateReferenceStatus(
            locationDbId,
            'completed'
          );
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
    }

    // Emit realtime event that generation is complete
    await step.do('emit-complete-event', async () => {
      if (input.sequenceId && input.locationDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: input.locationDbId,
            status: 'completed',
            referenceImageUrl,
          }
        );
      }
    });

    logger.info(
      `[LocationSheetWorkflow:cf] Location reference workflow completed for ${input.locationName}`
    );

    const result: LocationSheetWorkflowResult = {
      referenceImageUrl,
      referenceImagePath,
      locationDbId: input.locationDbId,
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

    // Mark location reference as failed
    if (input.locationDbId && input.teamId) {
      await scopedDb.sequenceLocations.updateReferenceStatus(
        input.locationDbId,
        'failed',
        error
      );

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
