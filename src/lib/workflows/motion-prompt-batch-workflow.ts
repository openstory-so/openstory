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

import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  MotionPromptWorkflowInput,
  MotionPromptBatchWorkflowInput,
} from '@/lib/workflow/types';
import type { MotionPromptWorkflowResult } from '@/lib/workflows/motion-prompt-workflow';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';
import { sha256Hex } from '@/lib/ai/input-hash';
import {
  derivedShotForItem,
  shotWorkItems,
} from '@/lib/workflows/shot-work-items';

const logger = getLogger(['openstory', 'workflow', 'motion-prompt-batch']);

type MotionPromptBatchWorkflowResult = MotionPromptWorkflowResult[];

export class MotionPromptBatchWorkflow extends OpenStoryWorkflowEntrypoint<MotionPromptBatchWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionPromptBatchWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
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
      referenceOnly = false,
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
    const headItems = clipItems.filter((item) => item.isSceneHead);

    // ============================================================
    // PHASE 3: Motion Prompt Generation — LLM per scene-head, derived
    // extras (#1486 one clip per shot).
    // ============================================================
    const settled = await Promise.allSettled(
      headItems.map((item) => {
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
        const sceneBefore = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;
        const sceneAfter =
          sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : undefined;
        const childPayload: MotionPromptWorkflowInput = {
          reservationId: input.reservationId,
          scene,
          sceneBefore,
          sceneAfter,
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
          childId: `motion-prompt:${sequenceId}:${scene.sceneId}`,
          childPayload,
          spawnStepName: `spawn-mp-scene-${sceneIndex}`,
          awaitStepName: `await-mp-scene-${sceneIndex}`,
        });
      })
    );

    // Collect failures so we can surface a single descriptive error rather
    // than whatever happened to land in the first rejected slot.
    const failures: string[] = [];
    const results: MotionPromptWorkflowResult[] = [];
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        const head = headItems[i];
        results.push({
          ...outcome.value,
          shotId: outcome.value.shotId ?? head?.mapping.shotId,
        });
      } else {
        const scene = headItems[i]?.scene;
        const reason =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        failures.push(`scene ${scene?.sceneId ?? `#${i}`}: ${reason}`);
      }
    }

    if (failures.length > 0) {
      logger.warn(
        `[MotionPromptBatchWorkflow:cf] Motion prompt generation failed for ${failures.length}/${headItems.length} scenes; continuing with ${results.length}: ${failures.join('; ')}`
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
    if (results.length === 0 && headItems.length > 0) {
      // NonRetryableError so CF doesn't retry the entire fan-out when every
      // child has already exhausted its own retries. The base class routes
      // this through onFailure + notifyParentOfFailure.
      throw new NonRetryableError(
        `[MotionPromptBatchWorkflow:cf] Motion prompt generation failed for all ${headItems.length} scenes: ${failures.join('; ')}`,
        'MotionPromptFanOutError'
      );
    }

    const extraItems = clipItems.filter((item) => !item.isSceneHead);
    const extras = await step.do(
      'derive-extra-shot-motion-prompts',
      async (): Promise<MotionPromptWorkflowResult[]> => {
        const out: MotionPromptWorkflowResult[] = [];
        const headByScene = new Map(
          results.map((result) => [result.sceneId, result])
        );
        for (const item of extraItems) {
          const derived = derivedShotForItem(item, styleConfig);
          const motionPrompt =
            derived?.motionPrompt ??
            headByScene.get(item.scene.sceneId)?.motionPrompt;
          if (!motionPrompt?.fullPrompt) continue;
          let finalVersionId: string | null = null;
          if (item.mapping.shotId) {
            const written = await scopedDb.shotPromptVersions.writeAiVersion({
              shotId: item.mapping.shotId,
              text: motionPrompt.fullPrompt,
              dialogue: motionPrompt.dialogue,
              audio: motionPrompt.audio,
              usesStartFrame: !referenceOnly,
              inputHash: await sha256Hex({
                kind: 'derived-shot-motion',
                shotId: item.mapping.shotId,
                text: motionPrompt.fullPrompt,
              }),
              analysisModel: analysisModelId,
            });
            finalVersionId = written.id;
          }
          out.push({
            sceneId: item.scene.sceneId,
            shotId: item.mapping.shotId,
            motionPrompt,
            finalVersionId,
          });
        }
        return out;
      }
    );

    return [...results, ...extras].map((result) => ({
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
    // Mirror QStash's `failureFunction`, which returned a static string and
    // performed no DB writes — per-scene failures already surface via the
    // child workflow's own onFailure (e.g. shotPrompt.failed emits).
    logger.error(
      '[MotionPromptBatchWorkflow:cf] Motion prompt generation failed',
      {
        error,
      }
    );
  }
}
