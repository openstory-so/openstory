/**
 * Batch visual-prompt generation — one `FramePromptWorkflow` child per scene.
 *
 * Fans out to the child via Pattern 3 (`spawnAndAwaitChild`) so the parent stays
 * thin and each scene's spawn/await pair gets its own retry budget (see
 * await-child.ts). Spawns run in parallel via `Promise.all`; the awaits are
 * wrapped in `Promise.allSettled` so a single timed-out child does not tank the
 * whole run. Failure parity comes from `OpenStoryWorkflowEntrypoint`
 * (see base-workflow.ts).
 *
 * The child never reads the DB: each scene's anchor frame id is resolved at
 * shot-creation time in `scene-split-workflow` and threaded here via
 * `shotMapping` (#991). */

import { contentRejectionSummary } from '@/lib/ai/content-rejection';
import type { Scene, VisualPrompt } from '@/lib/ai/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  FramePromptWorkflowInput,
  FramePromptBatchWorkflowInput,
  FramePromptBatchWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'frame-prompt-batch']);

// This workflow's own env binding name, injected into each child's `_parent`
// hint so the child can notify it back (`env[name].get(instanceId).sendEvent`).
// A plain string literal, not a cast: the binding is declared on `CloudflareEnv`
// (worker-configuration.d.ts), so it's assignable to `parentBindingName` as-is.
const PARENT_BINDING_NAME = 'FRAME_PROMPT_BATCH_WORKFLOW';

type FramePromptResult = { sceneId: string; visual: VisualPrompt };

export class FramePromptBatchWorkflow extends OpenStoryWorkflowEntrypoint<FramePromptBatchWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<FramePromptBatchWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: WorkflowScopedDb
  ): Promise<FramePromptBatchWorkflowResult> {
    const input = event.payload;
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
    } = input;

    if (scenes.length === 0) {
      return { scenes: [], visualPromptsBySceneId: {} };
    }

    const visualPromptSceneBinding = this.env.FRAME_PROMPT_WORKFLOW;

    // ============================================================
    // PHASE 3: Visual Prompt Generation — fan out one
    // FramePromptWorkflow child per scene. Spawns happen in parallel
    // via Promise.all; the awaits are wrapped in Promise.allSettled so a
    // single timed-out child does not tank the entire parent run (each child
    // carries its own retry budget via spawnAndAwaitChild).
    // ============================================================
    const spawnPromises = scenes.map(async (scene, sceneIndex) => {
      const sceneBefore = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;
      const sceneAfter =
        sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : undefined;

      const mappingEntry = shotMapping?.find(
        (f) => f.analysisSceneId === scene.sceneId
      );

      const childPayload: FramePromptWorkflowInput = {
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
        sequenceId: input.sequenceId,
        // Shot id of the scene to save the visual prompt to, plus its anchor
        // frame id — both resolved at shot-creation time in scene-split and
        // threaded through `shotMapping` so the child never reads the DB (#991).
        shotId: mappingEntry?.shotId,
        frameId: mappingEntry?.frameId ?? null,
      };

      const childResult = await spawnAndAwaitChild<
        FramePromptWorkflowInput,
        FramePromptResult
      >(step, {
        binding: visualPromptSceneBinding,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId: event.instanceId,
        childId: `frame-prompt:${sequenceId ?? 'no-seq'}:${scene.sceneId}`,
        childPayload,
        spawnStepName: `spawn-vp-scene-${sceneIndex}`,
        awaitStepName: `await-vp-scene-${sceneIndex}`,
        timeout: '30 minutes',
      });

      return { scene, childResult };
    });

    const settled = await Promise.allSettled(spawnPromises);

    // Aggregate child results into the batch result in a durable step so the
    // merge is cached on replay alongside the per-scene spawns.
    const scenesWithVisualPrompts = await step.do(
      'merge-visual-prompts',
      async (): Promise<FramePromptBatchWorkflowResult> => {
        const successResults: Array<{
          scene: Scene;
          childResult: FramePromptResult;
        }> = [];
        const failedSceneIds: string[] = [];
        const failures: Array<{ name: string; reason: string }> = [];

        for (const [index, outcome] of settled.entries()) {
          const scene = scenes[index];
          if (outcome.status === 'rejected') {
            logger.error(
              `[FramePromptBatchWorkflow:cf] Child frame-prompt failed for scene ${scene?.sceneId ?? `index ${index}`}:`,
              {
                err: outcome.reason,
              }
            );
            if (scene) {
              failedSceneIds.push(scene.sceneId);
              failures.push({
                name: `Scene ${scene.sceneNumber}`,
                reason:
                  outcome.reason instanceof Error
                    ? outcome.reason.message
                    : String(outcome.reason),
              });
            }
            continue;
          }
          successResults.push(outcome.value);
        }

        if (failedSceneIds.length > 0) {
          // NonRetryableError (not WorkflowValidationError) because the base
          // class's re-wrap only runs at the runImpl catch boundary; a throw
          // inside step.do gets retried by CF's step machinery first.
          //
          // When EVERY child was stopped by a content filter, say so and name
          // the scenes: that message survives to `sequence.statusError`, where
          // the existing rejection classification renders it as a warning the
          // user can act on (#1304). Anything else keeps the diagnostic text.
          throw new NonRetryableError(
            contentRejectionSummary(failures) ??
              `frame-prompt child(ren) returned no body for scene(s) [${failedSceneIds.join(', ')}]. ` +
                `Check sub-workflow logs for the upstream failure.`,
            'WorkflowValidationError'
          );
        }

        // The child persists each prompt to `frame_prompt_versions` (#713) — it
        // is NOT merged back into `scene.prompts` (that field is gone). But we
        // ALSO return the generated prompts in memory, keyed by sceneId, so the
        // parent pipeline threads them to the next phase rather than re-reading
        // the racy DB mirror.
        const visualPromptsBySceneId: Record<string, VisualPrompt> = {};
        for (const scene of scenes) {
          const enrichment = successResults.find(
            (s) => s.childResult.sceneId === scene.sceneId
          );
          if (!enrichment) {
            throw new NonRetryableError(
              `Scene ID mismatch in visual prompts: expected "${scene.sceneId}" but AI returned [${successResults
                .map((s) => s.childResult.sceneId)
                .join(', ')}]. ` +
                `Input had [${scenes.map((s) => s.sceneId).join(', ')}].`,
              'WorkflowValidationError'
            );
          }
          visualPromptsBySceneId[scene.sceneId] = enrichment.childResult.visual;
        }
        return { scenes, visualPromptsBySceneId };
      }
    );

    return scenesWithVisualPrompts;
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<FramePromptBatchWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): void {
    logger.error(
      `[FramePromptBatchWorkflow:cf] Visual prompt generation failed: ${error}`
    );
  }
}
