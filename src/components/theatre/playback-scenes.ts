import type { SceneInput } from './concatenated-video-source';

type ShotWithVideoUrl = {
  video?: { url?: string | null } | null;
};

/**
 * Playable clips for the stitched SequencePlayer, in list order. Shots still
 * generating (no url) are skipped so the player can start as soon as the first
 * clip lands.
 */
export function toPlaybackScenes(
  shots: ReadonlyArray<ShotWithVideoUrl>
): SceneInput[] {
  const scenes: SceneInput[] = [];
  for (const shot of shots) {
    const url = shot.video?.url;
    if (!url) continue;
    scenes.push({ orderIndex: scenes.length, videoUrl: url });
  }
  return scenes;
}

/**
 * Identity of a stitched clip list (order + URLs). A new `SceneInput[]` of
 * the same clips (shots refetch while others generate) is not a new list (#1284).
 */
export function scenePlaybackKey(scenes: readonly SceneInput[]): string {
  return scenes.map((s) => `${s.orderIndex}:${s.videoUrl}`).join('\n');
}
