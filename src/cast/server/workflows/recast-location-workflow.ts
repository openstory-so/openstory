/**
 * Recast a sequence's location (#1695): the trigger re-pointed the
 * sequence's link at another of the team's locations, and this run
 * re-renders every shot set there. No sheet is drawn.
 *
 * The workflow reads nothing: the per-shot regenerate snapshots are resolved
 * in `recastLocation`, after the link moved, and inlined on the payload.
 */

import { DEFAULT_IMAGE_MODEL } from '@/models/models';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { getGenerationChannel } from '@/platform/realtime';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  RecastLocationWorkflowInput,
  RegenerateShotsWorkflowInput,
} from '@/platform/server/workflow/types';
import { computeRegenerateShotsBatchHash } from '@/shots/server/workflows/regenerate-shots-snapshot';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'recast-location']);

type RecastLocationWorkflowResult = {
  shotsRegenerated: number;
  shotsFailed: number;
};

/** Mirrors `RegenerateShotsWorkflow`'s return type (module-local there). */
type RegenerateShotsChildResult = {
  totalShots: number;
  successCount: number;
  failedShots: string[];
  divergedShotIds: string[];
};

/**
 * Hand the trigger-time snapshots to the regenerate-shots child, once the
 * batch hash says they arrived as sent. Pure.
 */
async function buildRegeneratePayload(
  input: RecastLocationWorkflowInput
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

  return {
    userId: input.userId,
    teamId: input.teamId,
    sequenceId,
    shotIds: input.shotSnapshots.map((s) => s.shotId),
    triggerKind: 'location' as const,
    triggerId: input.locationDbId,
    imageModel,
    aspectRatio,
    resolution: input.resolution,
    shotSnapshots: input.shotSnapshots,
    snapshotInputHash: input.snapshotInputHash,
  };
}

export class RecastLocationWorkflow extends OpenStoryWorkflowEntrypoint<RecastLocationWorkflowInput> {
  protected override readonly failureLabel = 'Location recast';

  protected override async runImpl(
    event: Readonly<WorkflowEvent<RecastLocationWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: WorkflowScopedDb
  ): Promise<RecastLocationWorkflowResult> {
    const input = event.payload;

    logger.info(
      `[RecastLocationWorkflow:cf] Starting recast to ${input.locationName} with ${input.shotSnapshots.length} affected shots`
    );

    if (input.shotSnapshots.length === 0) {
      return { shotsRegenerated: 0, shotsFailed: 0 };
    }

    const result = await spawnAndAwaitChild<
      RegenerateShotsWorkflowInput,
      RegenerateShotsChildResult
    >(step, {
      binding: this.env.REGENERATE_SHOTS_WORKFLOW,
      parentBindingName: 'RECAST_LOCATION_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `regenerate-shots:location:${input.locationDbId}`,
      childPayload: await step.do('build-regenerate-snapshot', () =>
        buildRegeneratePayload(input)
      ),
      spawnStepName: 'spawn-regenerate-shots',
      awaitStepName: 'await-regenerate-shots',
    });

    return {
      shotsRegenerated: result.successCount,
      shotsFailed: result.failedShots.length,
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
