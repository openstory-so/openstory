/**
 * Music prompt for a sequence whose shots already have derived motion text.
 * The motion-prompt LLM this used to fan out is retired (#1923). The result
 * still carries empty motion maps so a parent typed against the old shape
 * keeps compiling.
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { reinforceInstrumentalTags } from '@/audio/server/music-prompt';
import { DEFAULT_MUSIC_MODEL } from '@/models/models';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import type {
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/platform/server/workflow/types';
import {
  joinMusicDesignByIndex,
  musicSceneSummariesFromAnalysis,
} from '@/audio/server/workflows/music-scene-summaries';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-music-prompts']);

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
      sequenceId,
      userId,
      teamId,
    } = input;

    const sceneSummaries = musicSceneSummariesFromAnalysis(
      scenesWithVisualPrompts
    );

    const musicDesign = await spawnAndAwaitChild<
      MusicPromptWorkflowInput,
      MusicPromptWorkflowResult
    >(step, {
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
        // Nothing spawns this workflow any more (drain path, #1923) and its
        // payload carries no audio model; a failure is recorded against the
        // default one.
        musicModel: DEFAULT_MUSIC_MODEL,
      },
      spawnStepName: 'spawn-music-prompt',
      awaitStepName: 'await-music-prompt',
      timeout: '45 minutes',
    });

    const completeScenes: Scene[] = await step.do('merge-music', () => {
      const echoedIds = musicDesign.scenes.map((s) => s.sceneId);
      const expectedIds = scenesWithVisualPrompts.map((s) => s.sceneId);
      if (echoedIds.some((id, i) => id !== expectedIds[i])) {
        logger.warn(
          '[MotionMusicPrompts] Music design sceneIds did not match; pairing by index',
          { sequenceId, expected: expectedIds, echoed: echoedIds }
        );
      }
      return Promise.resolve(
        joinMusicDesignByIndex(scenesWithVisualPrompts, musicDesign.scenes)
      );
    });

    return {
      completeScenes,
      motionPromptsBySceneId: {},
      motionPromptVersionIdsBySceneId: {},
      motionPromptsByShotId: {},
      motionPromptVersionIdsByShotId: {},
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
      `[MotionMusicPromptsWorkflow:cf] Music prompt generation failed: ${error}`
    );
  }
}
