/**
 * Rebuild the music-design chat user message the full-pipeline e2e sends.
 * Live snaps durations to the recorded motion model before the LLM call
 * (`MotionMusicPromptsWorkflow` snap-durations step).
 */

import { snapDuration } from '@/lib/motion/snap-duration';
import { getChatPrompt } from '@/lib/prompts';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import {
  extractTaggedJson,
  loadOpenrouterStage,
  recordedCurrentSceneSchema,
  replayRecordedE2eScenes,
  visualPromptResponseSchema,
} from './recorded-e2e-scenes';

/** Must match `RECORDED_PIPELINE_SETTINGS.motionModel` in e2e/fixtures/test-utils.ts. */
const RECORDED_MOTION_MODEL = 'seedance_v2' as const;

export async function reconstructRecordedMusicDesignPrompt(): Promise<string> {
  const { scenes } = replayRecordedE2eScenes();
  const visualSummaryBySceneId: Record<string, string> = {};
  for (const file of loadOpenrouterStage('visual-prompts')) {
    const fixture = file.fixtures[0];
    if (!fixture?.match.userMessage) continue;
    const recorded = extractTaggedJson(
      fixture.match.userMessage,
      'CURRENT_SCENE',
      recordedCurrentSceneSchema
    );
    const responseContent = fixture.response.content;
    if (responseContent === undefined) continue;
    const parsed = visualPromptResponseSchema.parse(
      JSON.parse(responseContent) as unknown
    );
    const scene = scenes[recorded.sceneNumber - 1];
    if (!scene) continue;
    visualSummaryBySceneId[scene.sceneId] = parsed.visual?.fullPrompt ?? '';
  }

  const snapped = scenes.map((scene) => ({
    ...scene,
    metadata: {
      ...scene.metadata,
      durationSeconds: snapDuration(
        scene.metadata.durationSeconds,
        RECORDED_MOTION_MODEL
      ),
    },
  }));
  const summaries = buildMusicSceneSummaries(snapped, visualSummaryBySceneId);
  const { messages } = await getChatPrompt('phase/music-design-chat', {
    scenes: JSON.stringify(summaries, null, 2),
    sceneCount: String(summaries.length),
  });
  const user = messages.find((message) => message.role === 'user');
  if (!user || typeof user.content !== 'string') {
    throw new Error('music-design: no user message');
  }
  return user.content;
}
