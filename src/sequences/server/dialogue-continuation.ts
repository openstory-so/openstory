import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import { ValidationError } from '@/platform/errors';
import type { GenerationCheckpoint } from '@/sequences/pipeline';
import type { MotionPrompt } from '@/shots/scene-analysis.schema';
import { shotWorkItems } from '@/shots/server/shot-work-items';

/** Freeze completed work at the continue click, including edits since the stop. */
export async function snapshotDialogueContinuation(
  scopedDb: ScopedDb,
  sequence: Pick<Sequence, 'musicPrompt' | 'musicTags'>,
  checkpoint: GenerationCheckpoint
): Promise<NonNullable<GenerationCheckpoint['imageStage']>> {
  const scenes = checkpoint.scenesWithVisualPrompts ?? checkpoint.scenes;
  if (!scenes || !checkpoint.shotMapping) {
    throw new ValidationError(
      'Cannot continue dialogue: missing script checkpoint'
    );
  }
  const items = shotWorkItems(scenes, checkpoint.shotMapping);
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
      dialogue: motion.dialogue ?? { presence: false, lines: [] },
      audio: motion.audio ?? { ambientSound: '', soundEffects: [] },
    };
    motionPromptVersionIdsByShotId[shotId] = motion.id;
  }
  return {
    images: { imageUrls, frameVersionIds },
    prompts: {
      completeScenes: scenes,
      motionPromptsBySceneId: {},
      motionPromptsByShotId,
      motionPromptVersionIdsByShotId,
      musicPrompt: sequence.musicPrompt ?? '',
      musicTags: sequence.musicTags ?? '',
    },
  };
}
