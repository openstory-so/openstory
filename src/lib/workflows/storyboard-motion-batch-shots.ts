/**
 * Build the per-shot payload analyze-script hands to motion-batch.
 *
 * The still URL, the `frame_variants` version that produced it, and the
 * `shot_prompt_versions` row the motion-prompt child just wrote are all
 * snapshotted here — the motion child never re-derives them (#1380). Omitting
 * the version ids stamps `video_variants.manifest` with nulls, so every
 * auto-motion clip is born Stale.
 */

import type { ImageToVideoModel } from '@/lib/ai/models';
import type { MotionPrompt, Scene } from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { CharacterMinimal, SequenceElementMinimal } from '@/lib/db/schema';
import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import { buildMotionReferenceImages } from '@/lib/motion/build-motion-references';
import { getLogger } from '@/lib/observability/logger';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { BatchMotionMusicWorkflowInput } from '@/lib/workflow/types';

const logger = getLogger(['openstory', 'workflow', 'analyze-script']);

type ShotMapping = Array<{
  analysisSceneId: string;
  shotId: string;
  frameId?: string | null;
}>;

export function buildStoryboardMotionBatchShots(input: {
  scenes: readonly Scene[];
  shotMapping: ShotMapping;
  /** Aligned to `scenes`; a null slot means that scene's still failed. */
  imageUrls: readonly (string | null)[];
  /** Aligned to `scenes` / `imageUrls`. */
  frameVersionIds: readonly (string | null)[];
  motionPromptsBySceneId: Record<string, MotionPrompt | undefined>;
  motionPromptVersionIdsBySceneId: Record<string, string | null | undefined>;
  videoModel: ImageToVideoModel;
  aspectRatio: AspectRatio;
  characters: CharacterMinimal[];
  elements: SequenceElementMinimal[];
}): BatchMotionMusicWorkflowInput['shots'] {
  return input.scenes.flatMap((scene, index) => {
    const matchedShot = input.shotMapping.find(
      (f) => f.analysisSceneId === scene.sceneId
    );
    // `imageUrls` is aligned to scene order; a null slot means that
    // scene's image generation failed (the shot is already marked
    // failed by the image workflow). Motion-prompt batch also skips
    // those scenes (no starting frame). Skip rather than throwing —
    // a missing still used to fail the whole storyboard.
    const imageUrl = input.imageUrls[index];
    if (!imageUrl) {
      logger.warn(
        `[AnalyzeScriptWorkflow:cf] Scene ${scene.sceneId} has no generated image (index ${index}); skipping its motion`
      );
      return [];
    }

    const motionPromptData = input.motionPromptsBySceneId[scene.sceneId];
    if (!motionPromptData?.fullPrompt) {
      throw new WorkflowValidationError(
        `Scene ${scene.sceneId} has no motion prompt`
      );
    }

    const characterTags = scene.continuity?.characterTags;

    return {
      shotId: matchedShot?.shotId ?? '',
      imageUrl,
      frameVersionId: input.frameVersionIds[index] ?? null,
      motionPromptVersionId:
        input.motionPromptVersionIdsBySceneId[scene.sceneId] ?? null,
      // Primary-model prompt (fallback / single-model). `motion-batch`
      // re-assembles per model from `motionPrompt` for the alternates.
      prompt: assembleMotionPrompt({
        motionPrompt: motionPromptData,
        model: input.videoModel,
        characterTags,
      }),
      model: input.videoModel,
      motionPrompt: motionPromptData,
      characterTags,
      duration: scene.metadata?.durationSeconds || 3,
      aspectRatio: input.aspectRatio,
      // Cast/element refs so motion preserves identity across the clip
      // (#873) — only Kling v3 Pro emits them. Same library + matcher the
      // image step uses, so motion attaches the same references.
      referenceImages: buildMotionReferenceImages({
        scene,
        characters: input.characters,
        elements: input.elements,
      }),
    };
  });
}
