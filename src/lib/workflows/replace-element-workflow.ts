/**
 * Cloudflare Workflows port of `replaceElementWorkflow`.
 *
 * Keep this workflow wired. The replace UI (#1192) currently persists the
 * new image and re-runs vision, then leaves affected shots stale. A later
 * "apply to shots" action should trigger this fan-out again.
 *
 * Mirrors the QStash version (`src/lib/workflows/replace-element-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The vision call inlines into a single `describe-new-element` step
 *     instead of invoking the `element-vision` child workflow — matches the
 *     QStash original, which also runs vision in-process here. The
 *     `ElementVisionWorkflow` child is exercised by *other* trigger paths.
 *   - Per-shot fan-out uses `spawnAndAwaitChild` (Pattern 3) to invoke
 *     `ImageWorkflow` for each affected shot, with `Promise.all` to spawn
 *     in parallel and `Promise.allSettled` to gather results so a single
 *     timed-out child cannot tank the rest of the batch.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId` (not needed by this workflow, but included
 *     here for parity with other CF ports). */

import {
  describeElementImage,
  ELEMENT_VISION_MODEL,
} from '@/lib/ai/element-vision';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import {
  DEFAULT_IMAGE_MODEL,
  safeTextToImageModel,
  supportsReferenceImages,
} from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ElementVisionStatus } from '@/lib/db/schema';
import {
  getGenerationChannel,
  type ReplaceElementCompletePayload,
  type ReplaceElementFailedPayload,
  type ReplaceElementStartPayload,
} from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  ImageWorkflowInput,
  MotionWorkflowInput,
  ReplaceElementShotSnapshot,
  ReplaceElementWorkflowInput,
  ReplaceElementWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'replace-element']);

// This workflow's own env binding name, injected into each child's `_parent`
// hint so the child can notify it back (`env[name].get(instanceId).sendEvent`).
// A plain string literal, not a cast: the binding is declared on `CloudflareEnv`
// (worker-configuration.d.ts), so it's assignable to `parentBindingName` as-is.
const PARENT_BINDING_NAME = 'REPLACE_ELEMENT_WORKFLOW';

type ImageChildResult = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
};

type MotionChildResult = {
  videoUrl: string;
  duration: number;
};

export type ShotResult =
  | { shotId: string; success: true; imageUrl: string }
  | { shotId: string; success: false; error: string };

type BatchOutcome =
  | { kind: 'complete'; successCount: number; failedCount: number }
  | { kind: 'fail'; sampleReason: string; total: number };

/**
 * Pure decision: given per-shot results, should the workflow emit `:complete`
 * or throw to trigger the base class's `onFailure` hook? Skipped-deleted
 * shots never enter `results` so they don't count against the success floor.
 */
export function decideBatchOutcome(results: ShotResult[]): BatchOutcome {
  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.length - successCount;
  if (results.length === 0) {
    return { kind: 'complete', successCount: 0, failedCount: 0 };
  }
  if (successCount === 0) {
    const firstFailure = results.find(
      (r): r is Extract<ShotResult, { success: false }> => !r.success
    );
    const sampleReason = firstFailure?.error ?? 'image edit failed';
    return { kind: 'fail', sampleReason, total: results.length };
  }
  return { kind: 'complete', successCount, failedCount };
}

/**
 * Pure split of the trigger-time shot ids into the ones that still exist and
 * the ones deleted mid-flight. Order comes from the payload (not the DB row
 * order) so every replay indexes the same shot at the same child step name.
 */
export function partitionShotIds(
  affectedShotIds: string[],
  survivingShotIds: string[]
): { liveShotIds: string[]; skippedDeletedShotIds: string[] } {
  const surviving = new Set(survivingShotIds);
  return {
    liveShotIds: affectedShotIds.filter((id) => surviving.has(id)),
    skippedDeletedShotIds: affectedShotIds.filter((id) => !surviving.has(id)),
  };
}

/**
 * Pure decision: which shots get a video re-render. "Had a video" is read from
 * the trigger-time snapshot, never re-queried — the motion children spawned
 * here repoint the very selection pointer that answer comes from.
 */
export function selectVideoRegenShotIds(
  liveShotIds: string[],
  snapshots: Record<string, ReplaceElementShotSnapshot>,
  editedShotIds: ReadonlySet<string>
): string[] {
  return liveShotIds.filter(
    (id) => !!snapshots[id]?.hasVideo && editedShotIds.has(id)
  );
}

/**
 * Pure decision: when `onFailure` fires, should the element's `visionStatus`
 * be downgraded to `'failed'`? Only when vision was still in flight — if
 * vision already succeeded, the failure was in a per-shot edit and
 * downgrading would mislead the element card into showing "vision failed".
 */
export function shouldDowngradeVisionOnFailure(
  current: ElementVisionStatus
): boolean {
  return current !== 'completed';
}

/**
 * Best-effort string extraction from a `Promise.allSettled` rejection reason.
 * Errors thrown by application code are usually `Error`, but third-party SDKs
 * and async helpers can reject with strings, plain objects, or
 * DOMException-like values; serializing those preserves the production trail
 * instead of collapsing to a literal `'unknown'`.
 */
export function rejectionReasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    const json = JSON.stringify(reason);
    if (json && json !== '{}') return json;
  } catch {
    // Circular references etc. fall through to the typeof tag.
  }
  return `non-error rejection (${typeof reason})`;
}

/**
 * Pure conversion of a `Promise.allSettled` entry into a `ShotResult`.
 * Fulfilled entries pass through; rejected entries become a failure result
 * tagged with `fallbackShotId` (the shot whose edit was awaited at this
 * index) or `'unknown'` when that lookup came back empty.
 */
export function settledToResult(
  settled: PromiseSettledResult<ShotResult>,
  fallbackShotId: string | undefined
): ShotResult {
  if (settled.status === 'fulfilled') return settled.value;
  return {
    shotId: fallbackShotId ?? 'unknown',
    success: false,
    error: rejectionReasonMessage(settled.reason),
  };
}

export function buildEditPrompt(args: {
  token: string;
  newDescription: string;
  previousDescription: string | null;
}): string {
  const previous = args.previousDescription
    ? ` (previously: ${args.previousDescription})`
    : '';
  return [
    `Edit the PRIMARY SOURCE image to replace the existing ${args.token} element${previous} with the new version shown in the ELEMENT REF image.`,
    `Render the new ${args.token} naturally where the old one appeared, matching scale, perspective, lighting, and occlusion of the original placement.`,
    `Keep all other content — characters, environment, framing, camera angle, color grading, and composition — exactly as they appear in the PRIMARY SOURCE. Only the ${args.token} element should change.`,
    args.newDescription
      ? `New element description: ${args.newDescription}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Emit a realtime event without letting transient Redis failures take down a
 * successful generation. The element card polls for the row's vision status,
 * so a dropped event degrades UX (no toast) but never blocks completion.
 */
async function safeEmit(
  sequenceId: string,
  label: string,
  fn: () => Promise<unknown> | null
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logger.error(
      `[ReplaceElementWorkflow:cf] emit ${label} for ${sequenceId} failed:`,
      {
        e,
      }
    );
  }
}

export class ReplaceElementWorkflow extends OpenStoryWorkflowEntrypoint<ReplaceElementWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ReplaceElementWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<ReplaceElementWorkflowResult> {
    const input = event.payload;
    const { sequenceId, elementId, affectedShotIds, newImageUrl } = input;
    let token = input.token;

    logger.info(
      `[ReplaceElementWorkflow:cf] Starting replace for element ${token} (${elementId}) — ${affectedShotIds.length} affected shots`
    );

    // Fires before vision so subscribers see the full lifecycle even if
    // vision throws.
    await step.do('emit-start', () =>
      safeEmit(sequenceId, 'start', () =>
        getGenerationChannel(sequenceId).emit(
          'generation.replace-element:start',
          {
            elementId,
            shotCount: affectedShotIds.length,
          } satisfies ReplaceElementStartPayload
        )
      )
    );

    const visionResult = await step.do('describe-new-element', async () => {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'analyzing'
      );
      const llmKeyInfo = await scopedDb.credentials.resolveLlmKey();
      const result = await describeElementImage({
        imageUrl: newImageUrl,
        filename: input.newFilename,
        llmKey: llmKeyInfo,
        observability: {
          userId: input.userId,
          sessionId: input.sequenceId,
          metadata: { elementId },
        },
      });
      await scopedDb.sequenceElements.updateVisionResult(
        elementId,
        result.description,
        result.consistencyTag
      );
      return result;
    });

    await step.do('deduct-vision-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: visionResult.costMicros,
        usedOwnKey: visionResult.usedOwnKey,
        description: `Element vision (${ELEMENT_VISION_MODEL})`,
        idempotencyKey: `${event.instanceId}:vision`,
        metadata: {
          model: ELEMENT_VISION_MODEL,
          elementId,
          sequenceId,
        },
        workflowName: 'ReplaceElementWorkflow',
      });
    });

    // Vision-driven auto-rename: if the new image suggests a meaningfully
    // different identifier AND that identifier isn't taken, cascade the
    // rename through script + shots before the edits so the rewritten
    // prompts/extracts land on the new token rather than the stale one.
    let renamedTo: string | undefined;
    if (visionResult.suggestedToken !== token) {
      const newToken = await step.do('auto-rename-token', async () => {
        const taken = await scopedDb.sequenceElements.isTokenTaken(
          sequenceId,
          visionResult.suggestedToken,
          elementId
        );
        if (taken) return null;
        const result = await scopedDb.sequenceElements.cascadeRename({
          sequenceId,
          elementId,
          oldToken: token,
          newToken: visionResult.suggestedToken,
        });
        return result.element.token;
      });
      if (newToken && newToken !== token) {
        renamedTo = newToken;
        token = newToken;
      }
    }

    if (affectedShotIds.length === 0) {
      await step.do('emit-complete-empty', () =>
        safeEmit(sequenceId, 'complete-empty', () =>
          getGenerationChannel(sequenceId).emit(
            'generation.replace-element:complete',
            {
              elementId,
              successCount: 0,
              failedCount: 0,
              renamedTo,
            } satisfies ReplaceElementCompletePayload
          )
        )
      );
      return {
        elementId,
        successCount: 0,
        failedCount: 0,
      };
    }

    const aspectRatio = input.aspectRatio;
    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
    const snapshots = input.shotSnapshotByShotId;

    // Shots captured at trigger time may have been deleted mid-flight. Treat
    // missing shots as skipped rather than aborting the whole batch. Only the
    // ids are consumed — every field the fan-out needs comes from the
    // trigger-time snapshot, because this workflow's own children repoint the
    // image/video selection pointers a re-read would follow.
    const survivingShotIds = await step.do('load-shots', async () => {
      const rows = await scopedDb.liveRead.shots.getByIds(affectedShotIds);
      return rows.map((s) => s.id);
    });
    const { liveShotIds, skippedDeletedShotIds } = partitionShotIds(
      affectedShotIds,
      survivingShotIds
    );

    // Flip every affected shot to `generating` and emit progress events
    // BEFORE fanning out per-shot edits. Otherwise the user can navigate to
    // a scene during the vision phase and see stale "completed" thumbnails —
    // the image-workflow's own set-generating-status step runs too late to
    // cover that window. Same upfront flip for videos: any shot with a
    // prior video will be regenerated, so its video tile should already read
    // as in-flight.
    await step.do('mark-shots-generating', async () => {
      for (const shotId of liveShotIds) {
        const snapshot = snapshots[shotId];
        if (!snapshot) continue;
        if (snapshot.frameId && snapshot.sourceImageUrl) {
          await scopedDb.frames.setImageGenerationStatus(
            snapshot.frameId,
            { imageStatus: 'generating', imageError: null },
            { throwOnMissing: false }
          );
          await safeEmit(sequenceId, `image-progress:${shotId}`, () =>
            getGenerationChannel(sequenceId).emit('generation.image:progress', {
              shotId,
              status: 'generating',
            })
          );
        }
        if (snapshot.hasVideo) {
          await safeEmit(sequenceId, `video-progress:${shotId}`, () =>
            getGenerationChannel(sequenceId).emit('generation.video:progress', {
              shotId,
              status: 'generating',
            })
          );
        }
      }
    });
    if (skippedDeletedShotIds.length > 0) {
      logger.warn(
        `[ReplaceElementWorkflow:cf] Skipping ${skippedDeletedShotIds.length} deleted shot(s): ${skippedDeletedShotIds.join(', ')}`
      );
    }

    const editPrompt = buildEditPrompt({
      token,
      newDescription: visionResult.description,
      previousDescription: input.previousDescription,
    });

    const imageBinding = this.env.IMAGE_WORKFLOW;

    // Parallel fan-out — per-child retries handle backpressure.
    // `allSettled` so a per-shot throw (e.g. timed-out child) doesn't abort
    // sibling shots.
    const imageSpawnPromises = liveShotIds.map(
      async (shotId, index): Promise<ShotResult> => {
        const snapshot = snapshots[shotId];
        const sourceImageUrl = snapshot?.sourceImageUrl;
        if (!sourceImageUrl) {
          // Replacement is only meaningful when a primary still exists;
          // text-to-image regeneration would silently invent a shot from
          // prose alone.
          return {
            shotId,
            success: false,
            error: 'no source thumbnail to edit',
          };
        }

        // Prefer the frame's own model when it supports edits, so the swap
        // reads as a continuation of the original render. Fall back to the
        // workflow's edit-capable default otherwise.
        const shotModel = safeTextToImageModel(
          snapshot.sourceModel,
          DEFAULT_IMAGE_MODEL
        );
        const model = supportsReferenceImages(shotModel)
          ? shotModel
          : imageModel;

        const childPayload: ImageWorkflowInput = {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          shotId,
          // Mandatory alongside `shotId` — without it the child renders and
          // bills, then writes nothing back to the frame (#1119).
          frameId: snapshot.frameId ?? undefined,
          prompt: editPrompt,
          model,
          imageSize: aspectRatioToImageSize(aspectRatio),
          resolution: input.resolution,
          numImages: 1,
          referenceImages: [
            {
              referenceImageUrl: sourceImageUrl,
              description: 'Existing shot to edit',
              role: 'primary',
            },
            {
              referenceImageUrl: newImageUrl,
              description: `${token} - ${visionResult.description}`,
              role: 'element',
            },
          ],
        };

        try {
          const childResult = await spawnAndAwaitChild<
            ImageWorkflowInput,
            ImageChildResult
          >(step, {
            binding: imageBinding,
            parentBindingName: PARENT_BINDING_NAME,
            parentInstanceId: event.instanceId,
            childId: `image:${sequenceId}:${shotId}`,
            childPayload,
            spawnStepName: `spawn-image-${index}`,
            awaitStepName: `await-image-${index}`,
            timeout: '30 minutes',
          });

          if (!childResult.imageUrl) {
            logger.error(
              `[ReplaceElementWorkflow:cf] Image edit returned empty url shot=${shotId}`
            );
            return {
              shotId,
              success: false,
              error: 'Image edit no imageUrl',
            };
          }

          return {
            shotId,
            success: true,
            imageUrl: childResult.imageUrl,
          };
        } catch (e) {
          const reason = rejectionReasonMessage(e);
          logger.error(
            `[ReplaceElementWorkflow:cf] Image edit failed shot=${shotId} reason=${reason}`
          );
          return {
            shotId,
            success: false,
            error: `Image edit failed: ${reason}`,
          };
        }
      }
    );

    const settled = await Promise.allSettled(imageSpawnPromises);

    const results: ShotResult[] = settled.map((s, i) => {
      if (s.status === 'rejected') {
        logger.error('[ReplaceElementWorkflow:cf] Per-shot promise rejected', {
          shotId: liveShotIds[i] ?? 'unknown',
          reason: s.reason,
        });
      }
      return settledToResult(s, liveShotIds[i]);
    });

    const outcome = decideBatchOutcome(results);
    if (outcome.kind === 'fail') {
      throw new Error(
        `[ReplaceElementWorkflow:cf] All ${outcome.total} shot edit(s) failed for ${token}: ${outcome.sampleReason}`
      );
    }

    // Cascade to videos: for each successfully-edited shot that previously
    // had a video, regenerate the video off the new thumbnail. The shot's
    // `videoStatus` flips to `generating` so the existing UI surfaces the
    // in-flight state on both the image and video pages.
    const successByShotId = new Map<string, string>();
    for (const r of results) {
      if (r.success) successByShotId.set(r.shotId, r.imageUrl);
    }
    // Same model the caller assembled every motion prompt for.
    const videoModel = input.videoModel;
    const shotIdsNeedingVideoRegen = selectVideoRegenShotIds(
      liveShotIds,
      snapshots,
      new Set(successByShotId.keys())
    );

    let videoSuccessCount = 0;
    let videoFailedCount = 0;
    if (shotIdsNeedingVideoRegen.length > 0) {
      logger.info(
        `[ReplaceElementWorkflow:cf] Regenerating video for ${shotIdsNeedingVideoRegen.length} shot(s) tied to element ${token}`
      );

      const motionBinding = this.env.MOTION_WORKFLOW;

      // Motion prompts were resolved by the caller and passed in
      // (`input.motionPromptByShotId`) — the workflow does NOT read the DB to
      // resolve them (#713/#991: racy + replay-unsafe). Keyed by shotId.
      const motionPromptByShotId = input.motionPromptByShotId;

      const motionSpawnPromises = shotIdsNeedingVideoRegen.map(
        async (shotId, index) => {
          const newThumbnailUrl = successByShotId.get(shotId);
          if (!newThumbnailUrl) {
            return { shotId, success: false };
          }

          // The caller resolves a motion prompt for every shot it asks to
          // re-render. A missing key is an invariant violation (the resolved map
          // fell out of sync with `shotIdsNeedingVideoRegen`), NOT a legitimate
          // empty prompt — fail loud rather than silently re-render with no motion
          // guidance. `''` is a valid resolved value and passes through.
          const motionPrompt = motionPromptByShotId[shotId];
          if (motionPrompt === undefined) {
            throw new NonRetryableError(
              `No resolved motion prompt for shot ${shotId} in replace-element re-render`,
              'WorkflowValidationError'
            );
          }

          const durationMs = snapshots[shotId]?.durationMs;
          const childPayload: MotionWorkflowInput = {
            userId: input.userId,
            teamId: input.teamId,
            sequenceId,
            shotId,
            imageUrl: newThumbnailUrl,
            referenceOnly: false,
            prompt: motionPrompt,
            model: videoModel,
            aspectRatio,
            resolution: input.resolution,
            duration: durationMs ? durationMs / 1000 : undefined,
          };

          try {
            await spawnAndAwaitChild<MotionWorkflowInput, MotionChildResult>(
              step,
              {
                binding: motionBinding,
                parentBindingName: PARENT_BINDING_NAME,
                parentInstanceId: event.instanceId,
                childId: `motion:${sequenceId}:${shotId}`,
                childPayload,
                spawnStepName: `spawn-motion-${index}`,
                awaitStepName: `await-motion-${index}`,
                timeout: '30 minutes',
              }
            );
            return { shotId, success: true };
          } catch (e) {
            logger.error('[ReplaceElementWorkflow:cf] motion child failed:', {
              err: rejectionReasonMessage(e),
            });
            return { shotId, success: false };
          }
        }
      );

      const videoSettled = await Promise.allSettled(motionSpawnPromises);
      for (const settledMotion of videoSettled) {
        if (
          settledMotion.status === 'fulfilled' &&
          settledMotion.value.success
        ) {
          videoSuccessCount += 1;
        } else {
          videoFailedCount += 1;
          if (settledMotion.status === 'rejected') {
            logger.error('[ReplaceElementWorkflow:cf] motion regen rejected:', {
              err: rejectionReasonMessage(settledMotion.reason),
            });
          }
        }
      }
    }

    await step.do('emit-complete', () =>
      safeEmit(sequenceId, 'complete', () =>
        getGenerationChannel(sequenceId).emit(
          'generation.replace-element:complete',
          {
            elementId,
            successCount: outcome.successCount,
            failedCount: outcome.failedCount,
            videoSuccessCount,
            videoFailedCount,
            renamedTo,
          } satisfies ReplaceElementCompletePayload
        )
      )
    );

    logger.info(
      `[ReplaceElementWorkflow:cf] Completed: ${outcome.successCount} edited, ${outcome.failedCount} failed, ${skippedDeletedShotIds.length} skipped-deleted, videos ${videoSuccessCount}/${videoFailedCount} for element ${token}`
    );

    return {
      elementId,
      successCount: outcome.successCount,
      failedCount: outcome.failedCount,
    };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ReplaceElementWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // The failure could be in vision (status still `analyzing`) or in a
    // per-shot edit (vision succeeded → status is `completed`). Only
    // downgrade in the first case; otherwise the element card would mislead
    // the user about which step failed.
    //
    // If reading the row throws (Turso blip), default to writing `failed`
    // anyway — better to mislabel as vision-failed than leave the row stuck
    // in `analyzing` forever (the whole point of this recovery).
    let shouldDowngrade = true;
    try {
      const current = await scopedDb.liveRead.sequenceElements.getById(
        input.elementId
      );
      if (current) {
        shouldDowngrade = shouldDowngradeVisionOnFailure(current.visionStatus);
      }
    } catch (e) {
      logger.error(
        '[ReplaceElementWorkflow:cf] Failed to read current element status; assuming vision in-flight:',
        {
          e,
        }
      );
    }

    if (shouldDowngrade) {
      try {
        await scopedDb.sequenceElements.updateVisionStatus(
          input.elementId,
          'failed',
          error
        );
      } catch (e) {
        logger.error(
          '[ReplaceElementWorkflow:cf] Failed to persist vision-failed status:',
          {
            e,
          }
        );
      }
    }

    await safeEmit(input.sequenceId, 'failed', () =>
      getGenerationChannel(input.sequenceId).emit(
        'generation.replace-element:failed',
        {
          elementId: input.elementId,
          error,
        } satisfies ReplaceElementFailedPayload
      )
    );

    logger.error(
      `[ReplaceElementWorkflow:cf] Replace failed for element ${input.token}: ${error}`
    );
  }
}
