/**
 * Cloudflare Workflows port of `motionMusicPromptsWorkflow`.
 *
 * Wave 3 mid-tier orchestrator: fans out to motion-prompts (per-scene tree)
 * and music-prompt (single scene-summaries → music design call) in parallel.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-music-prompts-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *   - Replaces `Promise.all([context.invoke(...), context.invoke(...)])` with
 *     two parallel `spawnAndAwaitChild` calls (Pattern 3).
 * */

import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { snapDuration } from '@/lib/motion/snap-duration';
import { reinforceInstrumentalTags } from '@/lib/prompts/music-prompt';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import type {
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  MotionPromptBatchWorkflowInput,
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/lib/workflow/types';
import type { MotionPromptWorkflowResult } from '@/lib/workflows/motion-prompt-workflow';
import {
  buildMusicSceneSummaries,
  joinMusicDesignByIndex,
} from '@/lib/workflows/music-scene-summaries';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-music-prompts']);

type MotionPromptsResult = MotionPromptWorkflowResult[];

export class MotionMusicPromptsWorkflow extends OpenStoryWorkflowEntrypoint<MotionMusicPromptsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionMusicPromptsWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: WorkflowScopedDb
  ): Promise<MotionMusicPromptsWorkflowResult> {
    const input = event.payload;
    const {
      scenesWithVisualPrompts,
      analysisModelId,
      videoModel,
      videoModels,
      sequenceId,
      userId,
      teamId,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible,
      styleConfig,
      shotMapping,
      startingFrameImageUrls,
      visualSummaryBySceneId,
    } = input;

    // Snap durations against the primary video model. The structured motion
    // prompts produced here are model-independent; per-model assembly happens
    // downstream in motion-batch (#545).
    const modelKey = videoModels?.[0] ?? videoModel ?? DEFAULT_VIDEO_MODEL;

    // Snap durations upfront so both motion prompts and music design see
    // identical, model-accurate duration values.
    const scenesWithSnappedDurations: Scene[] = await step.do(
      'snap-durations',
      () =>
        Promise.resolve(
          scenesWithVisualPrompts.map((scene) => ({
            ...scene,
            metadata: scene.metadata
              ? {
                  ...scene.metadata,
                  durationSeconds: snapDuration(
                    scene.metadata.durationSeconds,
                    modelKey
                  ),
                }
              : scene.metadata,
          }))
        )
    );

    // Build scene summaries for music design (uses snapped durations).
    const sceneSummaries = buildMusicSceneSummaries(
      scenesWithSnappedDurations,
      visualSummaryBySceneId
    );

    // Run motion prompts and music design in parallel via Pattern 3.
    const [motionPrompts, musicDesign] = await Promise.all([
      spawnAndAwaitChild<MotionPromptBatchWorkflowInput, MotionPromptsResult>(
        step,
        {
          binding: this.env.MOTION_PROMPT_BATCH_WORKFLOW,
          parentBindingName: 'MOTION_MUSIC_PROMPTS_WORKFLOW',
          parentInstanceId: event.instanceId,
          childId: `motion-prompts-batch:${sequenceId}`,
          childPayload: {
            userId,
            teamId,
            sequenceId,
            reservationId: input.reservationId,
            scenes: scenesWithSnappedDurations,
            aspectRatio,
            characterBible,
            locationBible,
            elementBible,
            styleConfig,
            analysisModelId,
            shotMapping,
            startingFrameImageUrls,
          },
          spawnStepName: 'spawn-motion-prompts',
          awaitStepName: 'await-motion-prompts',
          // Must exceed the child's own await budget: motion-prompts awaits
          // each per-scene grandchild for 30 minutes, plus notify lag under a
          // burst.
          timeout: '45 minutes',
        }
      ),
      spawnAndAwaitChild<MusicPromptWorkflowInput, MusicPromptWorkflowResult>(
        step,
        {
          binding: this.env.MUSIC_PROMPT_WORKFLOW,
          parentBindingName: 'MOTION_MUSIC_PROMPTS_WORKFLOW',
          parentInstanceId: event.instanceId,
          childId: `music-prompt:${sequenceId}`,
          childPayload: {
            userId,
            teamId,
            sequenceId,
            reservationId: input.reservationId,
            sceneSummaries,
            analysisModelId,
            promptSource: input.musicPromptSource,
          },
          spawnStepName: 'spawn-music-prompt',
          awaitStepName: 'await-music-prompt',
          // LLM-only child; headroom is for burst notify lag.
          timeout: '45 minutes',
        }
      ),
    ]);

    // Merge music design into scenes by index. The summaries we sent are
    // index-aligned; echoed ULIDs are not a reliable join key (same class
    // as style recommendation moving to catalog indices). Extra LLM rows
    // are dropped; a short list still throws.
    const completeScenes: Scene[] = await step.do(
      'merge-music-and-motion',
      () => {
        const echoedIds = musicDesign.scenes.map((s) => s.sceneId);
        const expectedIds = scenesWithSnappedDurations.map((s) => s.sceneId);
        if (echoedIds.some((id, i) => id !== expectedIds[i])) {
          logger.warn(
            '[MotionMusicPrompts] Music design sceneIds did not match; pairing by index',
            { sequenceId, expected: expectedIds, echoed: echoedIds }
          );
        }
        // Motion prompts are persisted to `shot_prompt_versions` by the
        // per-scene child (mirrored on `shot.motionPrompt`) — they are NOT
        // merged back into `scene.prompts` (#1143 / #713). Only music design
        // rides on the scene metadata here.
        return Promise.resolve(
          joinMusicDesignByIndex(scenesWithSnappedDurations, musicDesign.scenes)
        );
      }
    );

    // Return the generated motion prompts in memory, keyed by sceneId, so the
    // parent pipeline (analyze-script) threads them straight into the motion
    // render batch rather than re-reading the racy `shot.motionPrompt` mirror /
    // selected-version pointer from the DB (#713/#991). The per-scene child has
    // already persisted them to `shot_prompt_versions`.
    const motionPromptsBySceneId = Object.fromEntries(
      motionPrompts.map((m) => [m.sceneId, m.motionPrompt])
    );
    const motionPromptVersionIdsBySceneId = Object.fromEntries(
      motionPrompts.map((m) => [m.sceneId, m.finalVersionId ?? null])
    );

    return {
      completeScenes,
      motionPromptsBySceneId,
      motionPromptVersionIdsBySceneId,
      musicPrompt: musicDesign.prompt,
      musicTags: reinforceInstrumentalTags(musicDesign.tags),
    };
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<MotionMusicPromptsWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): void {
    logger.error(
      `[MotionMusicPromptsWorkflow:cf] Motion/music prompt generation failed: ${error}`
    );
  }
}
