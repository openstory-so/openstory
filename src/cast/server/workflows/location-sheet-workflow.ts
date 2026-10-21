/**
 * The `locationSheetWorkflow` durable workflow.

 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import { sheetGeneratedSummary } from '@/sequences/model-label';
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
import { landSheetRun } from './sheet-divergence';
import { triggerSheetPortrait } from '@/cast/server/sheets/sheet-portrait-trigger';
import type { SheetRunOutcome } from './sheet-divergence';
import {
  assertQueuedWithLocationRendering,
  locationSheetHashMatchesStored,
  NO_LEGACY_LOCATION_SHEET,
} from './sheet-snapshots';
import { locationChannelId } from '@/cast/cast-channel';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'location-sheet']);

export class LocationSheetWorkflow extends OpenStoryWorkflowEntrypoint<LocationSheetWorkflowInput> {
  protected override readonly failureLabel = 'Location sheet';

  protected override async runImpl(
    event: Readonly<WorkflowEvent<LocationSheetWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<LocationSheetWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    await step.do('validate-snapshot', async () => {
      assertQueuedWithLocationRendering(input);
      if (
        !(await locationSheetHashMatchesStored(
          input.snapshotInputHash,
          input,
          NO_LEGACY_LOCATION_SHEET
        ))
      ) {
        throw new WorkflowValidationError(
          'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
        );
      }
    });

    // Emit realtime event that generation has started
    await step.do('emit-start-event', async () => {
      await getGenerationChannel(
        locationChannelId(input.sequenceId, input.locationDbId)
      ).emit('generation.location-sheet:progress', {
        locationId: input.locationDbId,
        status: 'generating',
      });
    });

    // Step 1: Validate and build prompt
    const builtParams: ImageGenerationParams = await step.do(
      'build-prompt',
      async () => {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (!input.locationMetadata) {
          throw new WorkflowValidationError('locationMetadata is required');
        }

        logger.info(
          `[LocationSheetWorkflow:cf] Starting reference generation for location ${input.locationName}${input.referencePhotoUrls.length > 0 ? ` from ${input.referencePhotoUrls.length} photos` : ''}`
        );

        // The location's bible and rendering, drawn from its photos when it has any.
        const { prompt, referenceUrls } = buildLocationSheetPrompt(
          input.locationMetadata,
          input.referencePhotoUrls
        );
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // Location reference images use landscape aspect ratio for establishing shots
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          // The uploaded photos, when the location has any
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
        } satisfies ImageGenerationParams;
      }
    );

    // Destination is resolved BEFORE generating, because the image is stored
    // inside the generating step (#1645). A run from no sequence (#1695)
    // stores under the team and reports on the location's own channel.
    const locationDbId = input.locationDbId;
    const teamId = input.teamId;
    const sequenceId = input.sequenceId;
    const channelId = locationChannelId(sequenceId, locationDbId);
    const storageDir = `${teamId}/${sequenceId ?? 'team'}/${locationDbId}`;

    // Step 2: Generate the location reference image — reseeds on a content
    // flag, then one softened prompt (#1293). The upload rides the same step:
    // a via that answers with inline bytes has no URL to pass on, and the
    // whole image would otherwise ride the 1 MiB checkpoint (#1638).
    const generation = await generateImageSoftening({
      step,
      scopedDb,
      workflowRunId: event.instanceId,
      userId: input.userId,
      sequenceId: sequenceId ?? undefined,
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
          `${storageDir}/${generateId()}.png`
        ),
      onRetry: async (retry) => {
        await getGenerationChannel(channelId).emit(
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
        sequenceId: sequenceId ?? undefined,
        referenceImageCount: generationParams.referenceImageUrls?.length ?? 0,
      });
    });

    // Step 4: Land through the claim (#1113) — see the character twin.
    // A run queued before #1113 carries no claim: it lands only while no newer
    // run holds one, and otherwise parks instead of revoking that run's claim.
    const reconcileOutcome = await step.do(
      'reconcile-database',
      async (): Promise<SheetRunOutcome> => {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        const claimed = Boolean(input.referenceVersionId);
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        const versionId = input.referenceVersionId ?? generateId();
        return landSheetRun({
          land: () =>
            scopedDb.locationSheetVariants.promoteIfPending({
              locationId: locationDbId,
              versionId,
              claimed,
              url: storageResult.url,
              storagePath: storageResult.path,
              inputHash: input.snapshotInputHash,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a payload queued before #1600
              bibleVersionId: input.bibleVersionId ?? null,
              model: generationParams.model,
              workflowRunId,
              activity: sequenceId
                ? {
                    sequenceId,
                    actorId: input.userId,
                    targetType: 'location',
                    targetId: locationDbId,
                    summary: sheetGeneratedSummary(
                      input.locationName,
                      generationParams.model
                    ),
                  }
                : null,
            }),
          logger,
          logTag: '[LocationSheetWorkflow:cf]',
          channelId,
          entityType: 'location',
          entityId: locationDbId,
          versionId,
          claimed,
          storagePath: storageResult.path,
          snapshotInputHash: input.snapshotInputHash,
        });
      }
    );
    if (reconcileOutcome.kind === 'convergent') {
      sheetVersionId = reconcileOutcome.versionId;
    }

    // The sheet is saved: start its portrait run — see the character twin.
    await step.do('trigger-portrait', async () => {
      await triggerSheetPortrait(
        {
          userId: input.userId,
          teamId,
          sequenceId: sequenceId ?? undefined,
          subject: { kind: 'location', locationId: locationDbId },
          versionId: reconcileOutcome.versionId,
          sheetUrl: storageResult.url,
          storageDir,
        },
        await scopedDb.liveRead.compliance.listEnforcementFor(
          input.userId,
          teamId
        )
      );
    });

    if (reconcileOutcome.kind === 'divergent') {
      // `stale:detected` is out and the land batch settled the status
      // unless a newer run holds the claim — see the character twin.
      await step.do('settle-divergent-status', async () => {
        await getGenerationChannel(channelId).emit(
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
      await getGenerationChannel(channelId).emit(
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
      await scopedDb.locations.failReferenceClaim(
        input.locationDbId,
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a run queued before #1113 has no claim
        input.referenceVersionId ?? null,
        error
      );

      // Emit failure event for realtime UI update
      {
        try {
          await getGenerationChannel(
            locationChannelId(input.sequenceId, input.locationDbId)
          ).emit('generation.location-sheet:progress', {
            locationId: input.locationDbId,
            status: 'failed',
            error,
          });
        } catch (emitError) {
          logger.error(
            `[LocationSheetWorkflow:cf] Failed to emit failure event for location ${input.locationDbId}:`,
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
