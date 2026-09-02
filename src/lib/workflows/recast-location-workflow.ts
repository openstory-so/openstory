/**
 * Recast a sequence location onto a library location: regenerate its reference
 * image, then regenerate every shot set in that location.
 *
 * Both children are spawned with `spawnAndAwaitChild` (Pattern 3). The
 * workflow reads nothing: the sheet DTO and the per-shot regenerate snapshots
 * are resolved in `recastLocationFn` and inlined on the payload. The one input
 * that genuinely postdates the trigger — the reference the child just
 * generated — is merged into the snapshots in memory (`recast-snapshot.ts`).
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { getGenerationChannel } from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { CloudflareEnv } from '@/lib/workflow/types';
import type {
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
  RecastLocationWorkflowInput,
  RegenerateShotsWorkflowInput,
} from '@/lib/workflow/types';
import { computeRegenerateShotsBatchHash } from '@/lib/workflows/regenerate-shots-snapshot';
import { mergeRecastSheetIntoSnapshots } from '@/lib/workflows/recast-snapshot';
import { computeLocationSheetHashFromDto } from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'recast-location']);

type RecastLocationWorkflowResult = {
  referenceImageUrl: string;
  shotsRegenerated: number;
  shotsFailed: number;
  /**
   * The sheet child preserved the location's existing primary reference and
   * parked its output as a divergent variant, so no shot was regenerated —
   * regenerating here would render every shot against the OLD reference.
   */
  sheetDiverged: boolean;
};

/** Mirrors `RegenerateShotsWorkflow`'s return type (module-local there). */
type RegenerateShotsChildResult = {
  totalShots: number;
  successCount: number;
  failedShots: string[];
  divergedShotIds: string[];
};

/**
 * Substitute the freshly generated reference into the trigger-time snapshots
 * and hand them to the regenerate-shots child. Pure — the snapshots arrived on
 * the payload and the reference arrived in memory from the awaited child.
 */
async function buildRegeneratePayload(
  input: RecastLocationWorkflowInput,
  sheet: { imageUrl: string; inputHash: string | null }
): Promise<RegenerateShotsWorkflowInput> {
  const sequenceId = input.sequenceId;
  if (!sequenceId) {
    throw new NonRetryableError(
      '[RecastLocationWorkflow:cf] sequenceId is required to regenerate shots',
      'WorkflowValidationError'
    );
  }
  const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
  const aspectRatio = input.aspectRatio;

  const asSent = await computeRegenerateShotsBatchHash({
    sequenceId,
    imageModel,
    aspectRatio,
    shotSnapshots: input.shotSnapshots,
  });
  if (asSent !== input.snapshotInputHash) {
    throw new NonRetryableError(
      '[RecastLocationWorkflow:cf] snapshotInputHash does not match the inlined shot snapshots',
      'WorkflowValidationError'
    );
  }

  const merged = await mergeRecastSheetIntoSnapshots({
    shotSnapshots: input.shotSnapshots,
    sequenceId,
    imageModel,
    aspectRatio,
    sheetImageUrl: sheet.imageUrl,
    sheetInputHash: sheet.inputHash,
  });

  return {
    userId: input.userId,
    teamId: input.teamId,
    sequenceId,
    shotIds: merged.shotSnapshots.map((s) => s.shotId),
    triggerKind: 'location' as const,
    triggerId: input.locationDbId,
    imageModel,
    aspectRatio,
    resolution: input.resolution,
    shotSnapshots: merged.shotSnapshots,
    snapshotInputHash: merged.snapshotInputHash,
  };
}

async function regenerateShots(
  step: WorkflowStep,
  env: CloudflareEnv,
  parentInstanceId: string,
  input: RecastLocationWorkflowInput,
  sheet: { imageUrl: string; inputHash: string | null }
): Promise<{ shotsRegenerated: number; shotsFailed: number }> {
  if (input.shotSnapshots.length === 0) {
    return { shotsRegenerated: 0, shotsFailed: 0 };
  }

  const result = await spawnAndAwaitChild<
    RegenerateShotsWorkflowInput,
    RegenerateShotsChildResult
  >(step, {
    binding: env.REGENERATE_SHOTS_WORKFLOW,
    parentBindingName: 'RECAST_LOCATION_WORKFLOW',
    parentInstanceId,
    childId: `regenerate-shots:location:${input.locationDbId}`,
    childPayload: await step.do('build-regenerate-snapshot', () =>
      buildRegeneratePayload(input, sheet)
    ),
    spawnStepName: 'spawn-regenerate-shots',
    awaitStepName: 'await-regenerate-shots',
  });

  return {
    shotsRegenerated: result.successCount,
    shotsFailed: result.failedShots.length,
  };
}

export class RecastLocationWorkflow extends OpenStoryWorkflowEntrypoint<RecastLocationWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RecastLocationWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: WorkflowScopedDb
  ): Promise<RecastLocationWorkflowResult> {
    const input = event.payload;

    logger.info(
      `[RecastLocationWorkflow:cf] Starting recast for ${input.locationName} with ${input.shotSnapshots.length} affected shots`
    );

    const sheetBody = await step.do(
      'build-location-sheet-snapshot',
      async (): Promise<LocationSheetWorkflowInput> => {
        const partial: LocationSheetWorkflowInput = {
          locationDbId: input.locationDbId,
          locationName: input.locationName,
          locationMetadata: input.locationMetadata,
          sequenceId: input.sequenceId,
          teamId: input.teamId,
          userId: input.userId,
          imageModel: input.imageModel,
          referenceImageUrl: input.referenceImageUrl,
          libraryLocationDescription: input.libraryLocationDescription,
          styleConfig: input.styleConfig,
          libraryLocationReferenceHash: input.libraryLocationReferenceHash,
        };
        partial.snapshotInputHash =
          await computeLocationSheetHashFromDto(partial);
        return partial;
      }
    );

    const sheetResult = await spawnAndAwaitChild<
      LocationSheetWorkflowInput,
      LocationSheetWorkflowResult
    >(step, {
      binding: this.env.LOCATION_SHEET_WORKFLOW,
      parentBindingName: 'RECAST_LOCATION_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `location-sheet:${input.sequenceId ?? 'no-seq'}:${input.locationDbId}`,
      childPayload: sheetBody,
      spawnStepName: 'spawn-location-sheet',
      awaitStepName: 'await-location-sheet',
    });

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!sheetResult?.referenceImageUrl) {
      throw new Error(
        `Location reference generation failed for ${input.locationName}`
      );
    }

    const referenceImageUrl = sheetResult.referenceImageUrl;

    if (sheetResult.diverged) {
      logger.warn(
        `[RecastLocationWorkflow:cf] Reference diverged for ${input.locationName}; skipping shot regeneration against the unchanged reference`
      );
      return {
        referenceImageUrl,
        shotsRegenerated: 0,
        shotsFailed: 0,
        sheetDiverged: true,
      };
    }

    logger.info(
      `[RecastLocationWorkflow:cf] Location reference generated for ${input.locationName}, regenerating ${input.shotSnapshots.length} shots`
    );

    const { shotsRegenerated, shotsFailed } = await regenerateShots(
      step,
      this.env,
      event.instanceId,
      input,
      {
        imageUrl: referenceImageUrl,
        inputHash:
          sheetResult.sheetVersionId ?? sheetBody.snapshotInputHash ?? null,
      }
    );

    return {
      referenceImageUrl,
      shotsRegenerated,
      shotsFailed,
      sheetDiverged: false,
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RecastLocationWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    await getGenerationChannel(input.sequenceId).emit(
      'generation.recast-location:failed',
      {
        locationId: input.locationDbId,
        error,
      }
    );

    logger.error(
      `[RecastLocationWorkflow:cf] Recast failed for ${input.locationName}: ${error}`
    );
  }
}
