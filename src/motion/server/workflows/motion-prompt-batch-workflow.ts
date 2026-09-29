/**
 * Batch motion-prompt generation — mid-tier orchestrator.
 *
 * Fans out one `motion-prompt` child per scene via `spawnAndAwaitChild`
 * (Pattern 3 fan-out helpers in await-child.ts). Each child gets a deterministic
 * instance id and a unique event-type qualifier so siblings cannot match each
 * other's completion events. Extends `OpenStoryWorkflowEntrypoint`, so failure
 * handling comes from the base class (see base-workflow.ts).
 *
 * Uses `Promise.allSettled` rather than `Promise.all` so that a single child
 * timeout (waitForEvent default: 30 minutes) does not kill the parent — the
 * parent still surfaces a terminal error, but only after every other sibling has
 * resolved one way or the other. */

import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type {
  MotionPromptWorkflowInput,
  MotionPromptBatchWorkflowInput,
} from '@/platform/server/workflow/types';
import type { MotionPromptWorkflowResult } from './motion-prompt-workflow';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/platform/logger';
import type { MotionDialogue, Scene } from '@/shots/scene-analysis.schema';
import { shotDialogue } from '@/shots/shot-dialogue';
import { shotWorkItems } from '@/shots/server/shot-work-items';

const logger = getLogger(['openstory', 'workflow', 'motion-prompt-batch']);

/**
 * A clip's lines in the pipeline (#1784). A continue carries what each shot
 * says now (`dialogueLinesByShotId`, re-read from the shot node). Otherwise
 * its scene is already narrowed to the shot (`sceneForShot`), and scene-split
 * seeded the shot's dialogue node from these same stamped shot-list lines
 * moments earlier. A user edit that lands mid-run moves the node, so the
 * prompt honestly reads stale after.
 */
function seededDialogue(
  scene: Scene,
  shotId: string | undefined,
  linesByShotId: MotionPromptBatchWorkflowInput['dialogueLinesByShotId']
): MotionDialogue {
  const lines = shotId ? linesByShotId?.[shotId] : undefined;
  return shotDialogue(lines ?? scene.originalScript.dialogue);
}

type MotionPromptBatchWorkflowResult = MotionPromptWorkflowResult[];

export class MotionPromptBatchWorkflow extends OpenStoryWorkflowEntrypoint<MotionPromptBatchWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionPromptBatchWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: WorkflowScopedDb
  ): Promise<MotionPromptBatchWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const {
      scenes,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible,
      styleConfig,
      analysisModelId,
      shotMapping,
      sequenceId,
      startingFrameImageUrls,
      referenceOnly,
      dialogueLinesByShotId,
    } = input;

    // ============================================================
    // Top-level validation (re-throws as NonRetryableError via the base
    // class's WorkflowValidationError re-wrap). Inside step.do we use
    // CF's NonRetryableError directly so the step machinery doesn't burn
    // its retry budget on programmer errors.
    // ============================================================
    if (!sequenceId) {
      throw new WorkflowValidationError(
        '[MotionPromptBatchWorkflow:cf] sequenceId is required for fan-out'
      );
    }

    const childBinding = this.env.MOTION_PROMPT_WORKFLOW;
    const clipItems = shotWorkItems(scenes, shotMapping);
    // Regeneration always asks the LLM; first derived versions are authored
    // once by analysis, before the generation plan is frozen.

    const settled = await Promise.allSettled(
      clipItems.map((item) => {
        const { scene, sceneIndex, mapping } = item;
        const startingFrameImageUrl =
          (mapping.shotId
            ? startingFrameImageUrls?.[mapping.shotId]
            : undefined) ??
          startingFrameImageUrls?.[scene.sceneId] ??
          null;
        if (!startingFrameImageUrl && !referenceOnly) {
          return Promise.reject(
            new Error(
              `scene ${scene.sceneId} has no rendered starting frame (its image generation failed or was skipped); refusing to generate an unanchored motion prompt`
            )
          );
        }
        const childPayload: MotionPromptWorkflowInput = {
          reservationId: input.reservationId,
          scene,
          dialogue: seededDialogue(
            scene,
            mapping.shotId,
            dialogueLinesByShotId
          ),
          aspectRatio,
          characterBible,
          locationBible,
          elementBible,
          styleConfig,
          analysisModelId,
          teamId: input.teamId,
          userId: input.userId,
          sequenceId,
          shotId: mapping.shotId || undefined,
          startingFrameImageUrl,
          referenceOnly,
        };

        return spawnAndAwaitChild<
          MotionPromptWorkflowInput,
          MotionPromptWorkflowResult
        >(step, {
          binding: childBinding,
          parentBindingName: 'MOTION_PROMPT_BATCH_WORKFLOW',
          parentInstanceId,
          childId: `motion-prompt:${sequenceId}:${mapping.shotId || scene.sceneId}`,
          childPayload,
          spawnStepName: `spawn-mp-scene-${sceneIndex}-${mapping.shotNumber}`,
          awaitStepName: `await-mp-scene-${sceneIndex}-${mapping.shotNumber}`,
        });
      })
    );

    // Collect failures so we can surface a single descriptive error rather
    // than whatever happened to land in the first rejected slot.
    const failures: string[] = [];
    const results: MotionPromptWorkflowResult[] = [];
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        const head = clipItems[i];
        results.push({
          ...outcome.value,
          shotId: outcome.value.shotId ?? head?.mapping.shotId,
        });
      } else {
        const scene = clipItems[i]?.scene;
        const reason =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        failures.push(`scene ${scene?.sceneId ?? `#${i}`}: ${reason}`);
      }
    }

    if (failures.length > 0) {
      logger.warn(
        `[MotionPromptBatchWorkflow:cf] Motion prompt generation failed for ${failures.length}/${clipItems.length} scenes; continuing with ${results.length}: ${failures.join('; ')}`
      );
    }

    // Only a batch where NOTHING succeeded is fatal.
    //
    // Failing the whole batch on any single failure discarded a sequence's
    // entire render for one unanchorable scene — 17 of 18 shots rendered and
    // paid for, thrown away because scene 17's image tripped a content checker
    // (#1143). A shot without a motion prompt is simply a shot that can't be
    // animated yet; the user can regenerate it.
    //
    // It also stranded a sibling: the caller runs this and the music prompt
    // under one `Promise.all`, so throwing here rejected that immediately and
    // left the still-running music child to finish into a parent already in a
    // finite state.
    if (results.length === 0 && clipItems.length > 0) {
      // NonRetryableError so CF doesn't retry the entire fan-out when every
      // child has already exhausted its own retries. The base class routes
      // this through onFailure + notifyParentOfFailure.
      throw new NonRetryableError(
        `[MotionPromptBatchWorkflow:cf] Motion prompt generation failed for all ${clipItems.length} scenes: ${failures.join('; ')}`,
        'MotionPromptFanOutError'
      );
    }

    return results.map((result) => ({
      sceneId: result.sceneId,
      shotId: result.shotId,
      motionPrompt: result.motionPrompt,
      finalVersionId: result.finalVersionId ?? null,
    }));
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<MotionPromptBatchWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): void {
    // Log only, no DB writes: per-scene failures already surface via the
    // child workflow's own onFailure (e.g. shotPrompt.failed emits).
    logger.error(
      '[MotionPromptBatchWorkflow:cf] Motion prompt generation failed',
      {
        error,
      }
    );
  }
}
