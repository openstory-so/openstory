/**
 * Build the per-shot payload analyze-script hands to motion-batch.
 *
 * The still URL, the `frame_variants` version that produced it, and the
 * `shot_prompt_versions` row the motion-prompt child just wrote are all
 * snapshotted here — the motion child never re-derives them (#1380). Omitting
 * the version ids stamps `video_variants.manifest` with nulls, so every
 * auto-motion clip is born Stale.
 *
 * In reference-only mode there is no still and no frame version: every shot
 * carries `referenceOnly` instead of an `imageUrl`, and its reference set
 * gains the scene's location sheet, which the image-to-video path leaves out
 * because the still already fixed the set.
 */

import type { ImageToVideoModel } from '@/models/models';
import type { MotionPrompt, Scene } from '@/shots/scene-analysis.schema';
import type { AspectRatio } from '@/models/aspect-ratios';
import type { Resolution } from '@/models/resolutions';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/platform/server/db/schema';
import {
  matchingDialogueClips,
  modelTakesDialogueAudio,
  voicedDialogueLines,
} from '@/motion/dialogue-tts';
import { dialogueContextFor } from '@/shots/server/shot-dialogue';
import { shotDialogue, type ShotDialogueLine } from '@/shots/shot-dialogue';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import {
  assembleMotionPrompt,
  packedSceneFromScene,
} from '@/motion/server/assemble-motion-prompt';
import { buildMotionReferenceImages } from '@/motion/server/build-motion-references';
import { getLogger } from '@/platform/logger';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import type { BatchMotionMusicWorkflowInput } from '@/platform/server/workflow/types';
import {
  clipDurationSeconds,
  shotWorkItems,
  type ShotMappingRow,
} from '@/shots/server/shot-work-items';

const logger = getLogger(['openstory', 'workflow', 'analyze-script']);

/** A scene's mapped shots as `{ id, shotNumber }`, in shot order. */
export function sceneShotsOf(
  shotMapping: readonly ShotMappingRow[],
  sceneId: string
): Array<{ id: string; shotNumber: number }> {
  return shotMapping
    .filter((row) => row.analysisSceneId === sceneId && row.shotId)
    .map((row) => ({ id: row.shotId, shotNumber: row.shotNumber ?? 1 }))
    .sort((a, b) => a.shotNumber - b.shotNumber);
}

export function buildStoryboardMotionBatchShots(input: {
  scenes: readonly Scene[];
  shotMapping: ShotMappingRow[];
  /**
   * Primary still URL per clip, ALIGNED to `shotWorkItems(scenes, shotMapping)`
   * (scene order, then shotNumber). A 1-shot film is still one slot per scene.
   * A null slot means that clip's still failed.
   */
  imageUrls: readonly (string | null)[];
  /** Aligned to `imageUrls`. */
  frameVersionIds: readonly (string | null)[];
  motionPromptsBySceneId: Record<string, MotionPrompt | undefined>;
  motionPromptVersionIdsBySceneId: Record<string, string | null | undefined>;
  /** Per-clip prompts; wins over the scene map when present. */
  motionPromptsByShotId?: Record<string, MotionPrompt | undefined>;
  motionPromptVersionIdsByShotId?: Record<string, string | null | undefined>;
  videoModel: ImageToVideoModel;
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  characters: CharacterMinimal[];
  elements: SequenceElementMinimal[];
  /** Location sheets. Only attached in reference-only mode. */
  locations?: SequenceLocationMinimal[];
  /**
   * Reference-only mode: no stills were rendered, so `imageUrls` is empty by
   * design and the missing-still skip below must not eat every shot.
   */
  referenceOnly?: boolean;
  /** References-stage dialogue clips, keyed by shot id (#1554). */
  dialogueClipsByShotId?: Record<string, MotionAudioClip[]>;
  /**
   * Authored dialogue per shot id (#1657) — the same snapshot the Dialogue
   * stage recorded from, so the prompt's voiced lines and the clips bound to
   * them describe one set of words. Absent for a shot with no version row,
   * which falls back to the motion prompt's own copy.
   */
  dialogueLinesByShotId?: Record<string, ShotDialogueLine[]>;
  leftoverGrokShotIds?: readonly string[];
}): BatchMotionMusicWorkflowInput['shots'] {
  const leftoverGrok = new Set(input.leftoverGrokShotIds ?? []);
  const items = shotWorkItems(input.scenes, input.shotMapping);
  const linesByShotId = new Map(
    Object.entries(input.dialogueLinesByShotId ?? {})
  );
  return items.flatMap((item, index) => {
    const { scene, mapping } = item;
    const imageUrl = input.imageUrls[index];
    if (!imageUrl && !input.referenceOnly) {
      logger.warn(
        `[AnalyzeScriptWorkflow:cf] Shot ${mapping.shotId || scene.sceneId} has no generated image (index ${index}); skipping its motion`
      );
      return [];
    }

    const motionPromptData =
      (mapping.shotId
        ? input.motionPromptsByShotId?.[mapping.shotId]
        : undefined) ?? input.motionPromptsBySceneId[scene.sceneId];
    if (!motionPromptData?.fullPrompt) {
      throw new WorkflowValidationError(
        `Shot ${mapping.shotId || scene.sceneId} has no motion prompt`
      );
    }

    const characterTags = scene.continuity?.characterTags;
    const motionPromptVersionId =
      (mapping.shotId
        ? input.motionPromptVersionIdsByShotId?.[mapping.shotId]
        : undefined) ??
      input.motionPromptVersionIdsBySceneId[scene.sceneId] ??
      null;

    // The ASSEMBLED prompt, not `fullPrompt`, is what the reference matchers
    // have to scan (#1559): a dialogue line's bound voice element is named
    // only in the dialogue section assembly appends, so matching the raw
    // prompt would leave its token unsubstituted and its audio file off the
    // request. The single-shot path in `motion.fn.ts` already matched the
    // assembled text; this brings the batch in line with it.
    const shotModel =
      mapping.shotId && leftoverGrok.has(mapping.shotId)
        ? 'grok_imagine_video_1_5'
        : input.videoModel;
    const prompt = assembleMotionPrompt({
      motionPrompt: motionPromptData,
      model: shotModel,
      characterTags,
    });
    const shotLines = mapping.shotId
      ? input.dialogueLinesByShotId?.[mapping.shotId]
      : undefined;
    const voicedLines = modelTakesDialogueAudio(shotModel)
      ? voicedDialogueLines(
          shotLines ? shotDialogue(shotLines) : motionPromptData.dialogue,
          input.characters
        )
      : [];
    const audioClips = matchingDialogueClips(
      mapping.shotId
        ? input.dialogueClipsByShotId?.[mapping.shotId]
        : undefined,
      voicedLines
    );

    // No clip for these lines (the Dialogue stage was skipped, or it failed
    // for this shot): motion records its own, so hand it the conversation
    // around the shot and the reading is still acted in context (#1657).
    const dialogueContext = mapping.shotId
      ? dialogueContextFor({
          shot: { id: mapping.shotId },
          shotLines: shotLines ?? motionPromptData.dialogue.lines,
          voicedLines,
          audioClips,
          sceneShots: sceneShotsOf(input.shotMapping, scene.sceneId),
          linesByShotId,
          scriptDialogue: scene.originalScript.dialogue,
          characters: input.characters,
        })
      : undefined;

    return {
      shotId: mapping.shotId,
      sceneId: scene.sceneId,
      packedScene: packedSceneFromScene(scene),
      attachSceneHeader: item.hasSiblingShots,
      ...(input.referenceOnly
        ? { referenceOnly: true as const }
        : { referenceOnly: false as const, imageUrl: imageUrl ?? undefined }),
      frameVersionId: input.frameVersionIds[index] ?? null,
      motionPromptVersionId,
      prompt,
      model: shotModel,
      motionPrompt: motionPromptData,
      characterTags,
      duration: clipDurationSeconds(item),
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      referenceImages: buildMotionReferenceImages({
        scene,
        characters: input.characters,
        elements: input.elements,
        motionPrompt: prompt,
        referenceOnly: input.referenceOnly,
        locations: input.locations,
      }),
      voicedLines,
      ...(audioClips.length > 0 ? { audioClips } : {}),
      ...(dialogueContext ? { dialogueContext } : {}),
    };
  });
}
