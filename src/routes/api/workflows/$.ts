/**
 * Workflow Routes
 * Serves all QStash workflows for async AI task processing
 */

import { initAIEventBridge } from '@/lib/observability/ai-event-bridge';
import { withApiLogging } from '@/lib/observability/api-logger';
import { flushTracing, initTracing } from '@/lib/observability/tracing';
import {
  initMemoryProfiler,
  recordMemorySample,
} from '@/lib/observability/memory-profiler';
import { getQStashClient } from '@/lib/workflow/client';
import { analyzeScriptWorkflow } from '@/lib/workflows/analyze-script-workflow';
import { characterBibleWorkflow } from '@/lib/workflows/character-bible-workflow';
import { characterSheetWorkflow } from '@/lib/workflows/character-sheet-workflow';
import { frameImagesWorkflow } from '@/lib/workflows/frame-images-workflow';
import { generateImageWorkflow } from '@/lib/workflows/image-workflow';
import { libraryLocationSheetWorkflow } from '@/lib/workflows/library-location-sheet-workflow';
import { libraryTalentSheetWorkflow } from '@/lib/workflows/library-talent-sheet-workflow';
import { locationBibleWorkflow } from '@/lib/workflows/location-bible-workflow';
import { locationMatchingWorkflow } from '@/lib/workflows/location-matching-workflow';
import { locationSheetWorkflow } from '@/lib/workflows/location-sheet-workflow';
import { mergeAudioVideoWorkflow } from '@/lib/workflows/merge-audio-video-workflow';
import { mergeVideoWorkflow } from '@/lib/workflows/merge-video-workflow';
import { motionBatchWorkflow } from '@/lib/workflows/motion-batch-workflow';
import { motionMusicPromptsWorkflow } from '@/lib/workflows/motion-music-prompts-workflow';
import { motionPromptSceneWorkflow } from '@/lib/workflows/motion-prompt-scene-workflow';
import { motionPromptWorkflow } from '@/lib/workflows/motion-prompt-workflow';
import { generateMotionWorkflow } from '@/lib/workflows/motion-workflow';
import { generateMusicPromptWorflow } from '@/lib/workflows/music-prompt-workflow';
import { generateMusicWorkflow } from '@/lib/workflows/music-workflow';
import { recastCharacterWorkflow } from '@/lib/workflows/recast-character-workflow';
import { recastLocationWorkflow } from '@/lib/workflows/recast-location-workflow';
import { regenerateFramesWorkflow } from '@/lib/workflows/regenerate-frames-workflow';
import { sceneSplitWorkflow } from '@/lib/workflows/scene-split-workflow';
import { generateStoryboardWorkflow } from '@/lib/workflows/storyboard-workflow';
import { talentMatchingWorkflow } from '@/lib/workflows/talent-matching-workflow';
import { upscaleVariantWorkflow } from '@/lib/workflows/upscale-variant-workflow';
import { generateVariantWorkflow } from '@/lib/workflows/variant-workflow';
import { visualPromptSceneWorkflow } from '@/lib/workflows/visual-prompt-scene-workflow';
import { visualPromptWorkflow } from '@/lib/workflows/visual-prompt-workflow';
import { createFileRoute } from '@tanstack/react-router';
import { serveMany } from '@upstash/workflow/tanstack';

let _handler: ReturnType<typeof serveMany> | null = null;
function getHandler() {
  if (!_handler) {
    // Initialize Langfuse tracing and AI event bridge at load
    initTracing();
    initAIEventBridge();
    initMemoryProfiler();

    _handler = serveMany(
      {
        'analyze-script': analyzeScriptWorkflow,
        'motion-batch': motionBatchWorkflow,
        'character-sheet-from-bible': characterBibleWorkflow,
        'character-sheet': characterSheetWorkflow,
        'frame-images': frameImagesWorkflow,
        image: generateImageWorkflow,
        'library-location-sheet': libraryLocationSheetWorkflow,
        'library-talent-sheet': libraryTalentSheetWorkflow,
        'location-matching': locationMatchingWorkflow,
        'location-sheet-from-bible': locationBibleWorkflow,
        'location-sheet': locationSheetWorkflow,
        'merge-audio-video': mergeAudioVideoWorkflow,
        'merge-video': mergeVideoWorkflow,
        'motion-music-prompts': motionMusicPromptsWorkflow,
        'motion-prompt-scene': motionPromptSceneWorkflow,
        'motion-prompts': motionPromptWorkflow,
        motion: generateMotionWorkflow,
        'music-prompt': generateMusicPromptWorflow,
        music: generateMusicWorkflow,
        'scene-split': sceneSplitWorkflow,
        'recast-character': recastCharacterWorkflow,
        'recast-location': recastLocationWorkflow,
        'regenerate-frames': regenerateFramesWorkflow,
        storyboard: generateStoryboardWorkflow,
        'talent-matching': talentMatchingWorkflow,
        'upscale-variant': upscaleVariantWorkflow,
        'variant-image': generateVariantWorkflow,
        'visual-prompt-scene': visualPromptSceneWorkflow,
        'visual-prompts': visualPromptWorkflow,
      },
      {
        qstashClient: getQStashClient(),
      }
    );
  }
  return _handler;
}

export const Route = createFileRoute('/api/workflows/$')({
  server: {
    handlers: {
      POST: withApiLogging('workflows', async ({ request }) => {
        const workflowName =
          new URL(request.url).pathname.split('/api/workflows/')[1] ??
          'unknown';
        recordMemorySample(workflowName, 'before');
        const response = await getHandler().POST({ request });
        recordMemorySample(workflowName, 'after');

        if (response.status >= 400) {
          try {
            const cloned = response.clone();
            const body = await cloned.text();
            console.error(
              `[Workflow:${workflowName}] ${response.status} error:`,
              body
            );
          } catch (error) {
            console.error(
              `[Workflow:${workflowName}] ${response.status} error:`,
              error
            );
          }
        }

        await flushTracing();
        return response;
      }),
    },
  },
});
