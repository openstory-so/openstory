/**
 * Rebuild the music-design chat user message the full-pipeline e2e sends.
 * Live builds it from the analysis scenes through the same builder the
 * `MotionMusicPromptsWorkflow` uses (#1783): each scene's shot durations,
 * no visual prompt.
 */

import { getChatPrompt } from '@/platform/server/ai/prompts-index';
import { musicSceneSummariesFromAnalysis } from '@/audio/server/workflows/music-scene-summaries';
import { replayRecordedE2eScenes } from '@/sequences/server/recorded-e2e-scenes';

export async function reconstructRecordedMusicDesignPrompt(): Promise<string> {
  const { scenes } = replayRecordedE2eScenes();
  const summaries = musicSceneSummariesFromAnalysis(scenes);
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
