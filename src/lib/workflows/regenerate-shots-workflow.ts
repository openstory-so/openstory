/**
 * Cloudflare Workflows port of `regenerateShotsWorkflow`.
 *
 * Wave 3 fan-out leaf: bulk regenerates shot images after a character or
 * location recast. Mirrors the QStash version
 * (`src/lib/workflows/regenerate-shots-workflow.ts`) step for step — same
 * step names, same control flow, same side effects. The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`
 *     and the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - The Promise.all over `context.invoke('image', ...)` becomes a
 *     Pattern 3 `spawnAndAwaitChild` fan-out (`await-child.ts`), unbounded
 *     since #1143. Each child gets a deterministic
 *     instance ID (`image:${sequenceId}:${shotId}`) and a unique event-type
 *     qualifier so siblings cannot match each other's completion events.
 *   - Calls the snapshot DTO computer (`computeRegenerateShotsBatchHash`)
 *     directly inside `step.do('validate-snapshot')` instead of going
 *     through the `context.snapshot.*` extension.
 *   - `failureFunction` → `onFailure`. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { triggerWorkflow } from '@/lib/workflow/client';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  ImageWorkflowInput,
  RegenerateShotsWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  computeRegenerateShotsBatchHash,
  emitRecastEvent,
} from '@/lib/workflows/regenerate-shots-snapshot';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'regenerate-shots']);

/**
 * Concurrent fire-and-forget `/variant-image` creates.
 *
 * Kept when the image fan-out ceiling went away (#1143): these are
 * `binding.create()` calls rather than awaited children, and Cloudflare rate
 * limits instance creation at 100/second per workflow — so this bounds a
 * documented platform limit, not isolate pressure.
 */
const VARIANT_TRIGGER_CONCURRENCY = 8;

type ShotResult =
  | { shotId: string; success: true; imageUrl: string }
  | { shotId: string; success: false; error: string };

type RegenerateShotsResult = {
  totalShots: number;
  successCount: number;
  failedShots: string[];
  divergedShotIds: string[];
};

type ImageChildOutput = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
};

export class RegenerateShotsWorkflow extends OpenStoryWorkflowEntrypoint<RegenerateShotsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RegenerateShotsWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<RegenerateShotsResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { sequenceId, teamId, triggerKind, triggerId } = input;
    const label = buildWorkflowLabel(sequenceId);

    // ============================================================
    // Top-level validation (re-throws as NonRetryableError via the base
    // class's WorkflowValidationError re-wrap). Inside step.do we use
    // CF's NonRetryableError directly so the step machinery doesn't burn
    // its retry budget on programmer errors.
    // ============================================================
    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }

    const childBinding = this.env.IMAGE_WORKFLOW;

    // Validate the snapshot hash inside the workflow body. Mirrors the QStash
    // `validate-snapshot` step but calls the DTO computer directly because CF
    // has no `context.snapshot.*` extension.
    await step.do('validate-snapshot', async () => {
      const expected = input.snapshotInputHash;
      if (!expected) return;
      const recomputed = await computeRegenerateShotsBatchHash(input);
      if (recomputed !== expected) {
        throw new NonRetryableError(
          'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently',
          'WorkflowValidationError'
        );
      }
    });

    const snapshots = input.shotSnapshots;
    if (snapshots.length === 0) {
      return {
        totalShots: 0,
        successCount: 0,
        failedShots: [],
        divergedShotIds: [],
      };
    }

    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
    const aspectRatio = input.aspectRatio;

    await step.do('emit-start', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'start',
        sequenceId,
        triggerId,
        shotCount: snapshots.length,
      });
    });

    // ============================================================
    // PHASE: Per-shot image regeneration — Pattern 3 fan-out, unbounded
    // (#1143: the per-run ceiling measured no benefit and was never global).
    // allSettled so one failing shot doesn't poison its peers.
    // ============================================================
    const settled = await Promise.allSettled(
      snapshots.map(async (snapshot, shotIndex): Promise<ShotResult> => {
        if (!snapshot.imagePrompt) {
          // Per-shot failure — peer shots in the batch should still run.
          return {
            shotId: snapshot.shotId,
            success: false,
            error: 'no image prompt',
          };
        }

        const referenceImages = [
          ...snapshot.characterRefs,
          ...snapshot.locationRefs,
        ];

        const childPayload: ImageWorkflowInput = {
          userId: input.userId,
          teamId,
          sequenceId,
          shotId: snapshot.shotId,
          // Mandatory alongside `shotId` — without it the child renders and
          // bills, then writes nothing back to the frame (#1119).
          frameId: snapshot.frameId ?? undefined,
          prompt: snapshot.imagePrompt,
          model: imageModel,
          imageSize: aspectRatioToImageSize(aspectRatio),
          numImages: 1,
          referenceImages,
        };

        try {
          const body = await spawnAndAwaitChild<
            ImageWorkflowInput,
            ImageChildOutput
          >(step, {
            binding: childBinding,
            parentBindingName: 'REGENERATE_SHOTS_WORKFLOW',
            parentInstanceId,
            childId: `image:${sequenceId}:${snapshot.shotId}`,
            childPayload,
            spawnStepName: `spawn-image-${shotIndex}`,
            awaitStepName: `await-image-${shotIndex}`,
          });
          if (!body.imageUrl) {
            logger.error(
              `[RegenerateShotsWorkflow:cf] Image generation failed shot=${snapshot.shotId} reason=no imageUrl`
            );
            return {
              shotId: snapshot.shotId,
              success: false,
              error: 'Image generation no imageUrl',
            };
          }
          return {
            shotId: snapshot.shotId,
            success: true,
            imageUrl: body.imageUrl,
          };
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          logger.error(
            `[RegenerateShotsWorkflow:cf] Image generation failed shot=${snapshot.shotId} reason=${reason}`
          );
          return {
            shotId: snapshot.shotId,
            success: false,
            error: `Image generation failed: ${reason}`,
          };
        }
      })
    );

    // allSettled preserves input order; collect into ShotResult[] for reconcile.
    const imageResults: ShotResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      const snapshot = snapshots[i];
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      return {
        shotId: snapshot?.shotId ?? `#${i}`,
        success: false,
        error: `Image generation failed: ${reason}`,
      };
    });

    // Image-workflow (#989) appends + selects each new version itself, and on a
    // mid-flight input drift retains the version WITHOUT repointing the primary.
    // There is no separate divergence reconcile here anymore — a successful
    // image result means the frame's primary was (re)generated.
    const succeeded = imageResults.filter(
      (r): r is Extract<ShotResult, { success: true }> => r.success
    );
    const succeededShotIds = succeeded.map((r) => r.shotId);

    // Regenerate the 3×3 grid sheet for each (re)imaged shot — it is derived
    // from the primary still and would otherwise show the pre-recast subject.
    // Fire-and-forget creates, wave-bounded. Promise.all within each wave (not
    // allSettled) so a failed create fails the durable step and CF retries.
    await step.do('trigger-variant-regen', async () => {
      const enforcement = await scopedDb.liveRead.compliance.listEnforcementFor(
        input.userId,
        teamId
      );
      const limit = VARIANT_TRIGGER_CONCURRENCY;
      for (let i = 0; i < succeeded.length; i += limit) {
        const wave = succeeded.slice(i, i + limit);
        await Promise.all(
          wave.map(async (result) => {
            const snapshot = snapshots.find((s) => s.shotId === result.shotId);
            if (!snapshot) return;
            await triggerWorkflow<ShotVariantWorkflowInput>(
              '/variant-image',
              {
                userId: input.userId,
                teamId,
                sequenceId,
                shotId: result.shotId,
                frameId: snapshot.frameId ?? undefined,
                thumbnailUrl: result.imageUrl,
                scenePrompt: snapshot.imagePrompt,
                characterReferences:
                  snapshot.characterRefs.length > 0
                    ? snapshot.characterRefs
                    : undefined,
                locationReferences:
                  snapshot.locationRefs.length > 0
                    ? snapshot.locationRefs
                    : undefined,
                aspectRatio,
                model: imageModel,
              },
              {
                label,
                // Dedupe: a retry of this step.do mustn't re-fire variants.
                deduplicationId: `variant-image-${result.shotId}-${imageModel}-${snapshot.snapshotInputHash.slice(0, 16)}`,
                enforcement,
              }
            );
          })
        );
      }
    });

    const failedShots = imageResults
      .filter((r) => !r.success)
      .map((r) => r.shotId);
    const successCount = succeededShotIds.length;

    await step.do('emit-complete', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'complete',
        sequenceId,
        triggerId,
        successCount,
        failedCount: failedShots.length,
      });
    });

    logger.info(
      `[RegenerateShotsWorkflow] Completed: ${successCount} success, ${failedShots.length} failed`
    );

    return {
      totalShots: snapshots.length,
      successCount,
      failedShots,
      divergedShotIds: [],
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RegenerateShotsWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    if (input.sequenceId) {
      await emitRecastEvent({
        kind: input.triggerKind,
        event: 'failed',
        sequenceId: input.sequenceId,
        triggerId: input.triggerId,
        error,
      });
    }

    logger.error(
      `[RegenerateShotsWorkflow:cf] Shot regeneration failed: ${error}`
    );
  }
}
