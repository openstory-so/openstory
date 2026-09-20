import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { ValidationError } from '@/platform/errors';
import type { GenerationCheckpoint } from '@/sequences/pipeline';
import type { MotionPrompt } from '@/shots/scene-analysis.schema';
import { shotWorkItems } from '@/shots/server/shot-work-items';

/** Freeze completed work at the continue click, including edits since the stop. */
export async function snapshotDialogueContinuation(
  scopedDb: ScopedDb,
  sequence: Pick<Sequence, 'id' | 'musicPrompt' | 'musicTags'>,
  checkpoint: GenerationCheckpoint
): Promise<GenerationCheckpoint> {
  const savedScenes = checkpoint.scenesWithVisualPrompts ?? checkpoint.scenes;
  if (!savedScenes || !checkpoint.shotMapping) {
    throw new ValidationError(
      'Cannot continue dialogue: missing script checkpoint'
    );
  }
  // ID-based asset reads also return soft-deleted shots. Reconcile before
  // reading assets, and carry the same mapping into the downstream jobs.
  const liveShots = await scopedDb.shots.listBySequence(sequence.id);
  const liveShotIds = new Set(liveShots.map((shot) => shot.id));
  const shotMapping = checkpoint.shotMapping.filter((shot) =>
    liveShotIds.has(shot.shotId)
  );
  if (shotMapping.length === 0) {
    throw new ValidationError('Cannot continue dialogue: no remaining shots');
  }
  const sceneIds = new Set(shotMapping.map((shot) => shot.analysisSceneId));
  const scenes = savedScenes.filter((scene) => sceneIds.has(scene.sceneId));
  const items = shotWorkItems(scenes, shotMapping);
  const [anchors, motionByShot] = await Promise.all([
    scopedDb.frames.getAnchorsByShots(items.map((item) => item.mapping.shotId)),
    scopedDb.shotPromptVersions.getSelectedMotionByShots(
      items.map((item) => item.mapping.shotId)
    ),
  ]);
  const imagesByFrame = await scopedDb.frameVariants.getSelectedByFrameIds(
    [...anchors.values()].map((frame) => frame.id)
  );
  const imageUrls: (string | null)[] = [];
  const frameVersionIds: (string | null)[] = [];
  const motionPromptsByShotId: Record<string, MotionPrompt> = {};
  const motionPromptVersionIdsByShotId: Record<string, string> = {};
  for (const item of items) {
    const shotId = item.mapping.shotId;
    const frame = anchors.get(shotId);
    const image = frame ? imagesByFrame.get(frame.id) : undefined;
    const motion = motionByShot.get(shotId);
    if (!motion?.text.trim()) {
      throw new ValidationError(
        `Shot ${shotId} needs a motion prompt before continuing dialogue`
      );
    }
    imageUrls.push(image?.url ?? null);
    frameVersionIds.push(image?.id ?? null);
    motionPromptsByShotId[shotId] = {
      fullPrompt: motion.text,
      // Not a source of lines (#1657): the batch puts what the shot says
      // (`dialogueLinesByShotId`) into the prompt it assembles.
      dialogue: { presence: false, lines: [] },
      audio: motion.audio ?? { ambientSound: '', soundEffects: [] },
    };
    motionPromptVersionIdsByShotId[shotId] = motion.id;
  }
  return {
    ...checkpoint,
    scenes: checkpoint.scenes?.filter((scene) => sceneIds.has(scene.sceneId)),
    scenesWithVisualPrompts: scenes,
    shotMapping,
    dialogueClipsByShotId: checkpoint.dialogueClipsByShotId
      ? Object.fromEntries(
          Object.entries(checkpoint.dialogueClipsByShotId).filter(([shotId]) =>
            liveShotIds.has(shotId)
          )
        )
      : undefined,
    imageStage: {
      images: { imageUrls, frameVersionIds },
      prompts: {
        completeScenes: scenes,
        motionPromptsBySceneId: {},
        motionPromptsByShotId,
        motionPromptVersionIdsByShotId,
        musicPrompt: sequence.musicPrompt ?? '',
        musicTags: sequence.musicTags ?? '',
      },
    },
  };
}
