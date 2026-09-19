/** Pure wire projections shared by scene and shot readers. */
import { toShareableUrl } from '@/platform/server/storage/buckets';
import { usesStartFrame } from '@/shots/use-start-frame';
import type { StartFrameSequence } from '@/shots/use-start-frame';
import type {
  InspectionOptions,
  SceneInspectionRead,
  ShotInspectionRead,
} from './db/production-reads';

export function serializeShot(
  read: ShotInspectionRead,
  sequence: StartFrameSequence,
  origin: string,
  options: InspectionOptions
) {
  const { view: shot, anchorFrameId, selectedImageId, selectedVideoId } = read;
  const share = (url: string | null | undefined) =>
    url ? toShareableUrl(url, origin) : null;
  return {
    id: shot.id,
    sequenceId: shot.sequenceId,
    sceneId: shot.sceneId,
    shotNumber: shot.shotNumber,
    durationMs: shot.durationMs,
    useStartFrame: shot.useStartFrame,
    effectiveUseStartFrame: usesStartFrame(shot, sequence),
    renderSegmentId: shot.renderSegmentId,
    anchorFrame: anchorFrameId
      ? {
          id: anchorFrameId,
          status: shot.frame.imageStatus ?? 'pending',
          error:
            shot.frame.imageStatus === 'failed' ? shot.frame.imageError : null,
          selectedImage: {
            versionId: selectedImageId,
            usable: read.selectedImageUsable,
            ...(options.includeAssets
              ? {
                  url: share(shot.image?.url),
                  model: shot.image?.model ?? null,
                }
              : {}),
          },
          selectedPromptVersionId: shot.frame.selectedImagePromptVersionId,
          ...(options.includePrompts
            ? { prompt: shot.imagePromptVersion?.text ?? null }
            : {}),
          ...(options.includeAssets
            ? { previewUrl: share(shot.previewThumbnailUrl) }
            : {}),
        }
      : null,
    motion: {
      status:
        shot.primaryVideo?.status ??
        (selectedVideoId ? 'completed' : 'pending'),
      error:
        shot.primaryVideo?.status === 'failed' ? shot.primaryVideo.error : null,
      selectedVideo: {
        versionId: selectedVideoId,
        usable: read.selectedVideoUsable,
        ...(options.includeAssets
          ? { url: share(shot.video?.url), model: shot.video?.model ?? null }
          : {}),
      },
      selectedPromptVersionId: shot.selectedMotionPromptVersionId,
      ...(options.includePrompts
        ? { prompt: shot.motionPrompt?.fullPrompt ?? null }
        : {}),
    },
  };
}
export function serializeScene(
  read: Pick<SceneInspectionRead, 'scene' | 'shots' | 'shotsTruncated'>,
  sequence: StartFrameSequence,
  origin: string,
  options: InspectionOptions
) {
  const { scene } = read;
  return {
    id: scene.id,
    sequenceId: scene.sequenceId,
    orderIndex: scene.orderIndex,
    title: scene.title,
    location: scene.location,
    timeOfDay: scene.timeOfDay,
    storyBeat: scene.storyBeat,
    selectedScriptVersionId: scene.selectedScriptVersionId,
    shots: read.shots.map((shot) =>
      serializeShot(shot, sequence, origin, options)
    ),
    shotsTruncated: read.shotsTruncated,
  };
}
