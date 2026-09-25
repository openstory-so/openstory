/**
 * Rebuild the music-design chat user message the full-pipeline e2e sends.
 * Live builds it from the analysis scenes through the same builder the
 * `MotionMusicPromptsWorkflow` uses (#1783): each scene's shot durations and
 * its head shot's visual prompt.
 *
 * Every recorded scene has 2+ shots, so its visual grounding is the head
 * shot's DERIVED start-frame prompt (#1517) — the value analyze-script puts
 * in `visualPromptBySceneId` — under the style the spec selects. A 1-shot
 * scene would be LLM-authored and is not reconstructible here.
 */

import { getChatPrompt } from '@/platform/server/ai/prompts-index';
import { musicSceneSummariesFromAnalysis } from '@/audio/server/workflows/music-scene-summaries';
import { DEFAULT_STYLE_TEMPLATES } from '@/look/style-templates';
import { deriveShots } from '@/shots/shot-list.derive';
import { buildSceneWithShots } from '@/shots/shot-list-pass';
import { replayRecordedE2eScenes } from '@/sequences/server/recorded-e2e-scenes';

/** The style `full-sequence.spec.ts` picks on the composer strip. */
const RECORDED_STYLE_NAME = 'Product Ad';

export async function reconstructRecordedMusicDesignPrompt(): Promise<string> {
  const { scenes } = replayRecordedE2eScenes();
  const styleConfig = DEFAULT_STYLE_TEMPLATES.find(
    (template) => template.name === RECORDED_STYLE_NAME
  )?.config;
  if (!styleConfig) {
    throw new Error(`music-design: no "${RECORDED_STYLE_NAME}" style template`);
  }
  const visualSummaryBySceneId: Record<string, string> = {};
  for (const scene of scenes) {
    if ((scene.shots?.length ?? 0) < 2) {
      throw new Error(
        `music-design: scene ${scene.sceneNumber} is 1-shot; its visual prompt is LLM-authored, not derived`
      );
    }
    const [head] = deriveShots(buildSceneWithShots(scene), styleConfig);
    visualSummaryBySceneId[scene.sceneId] = head?.visualPrompt.fullPrompt ?? '';
  }
  const summaries = musicSceneSummariesFromAnalysis(
    scenes,
    visualSummaryBySceneId
  );
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
