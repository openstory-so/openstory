import type { SceneInput } from './concatenated-video-source';

import type { ShotView } from '@/shots/shot-view';
import {
  aspectRatioToDimensions,
  type AspectRatio,
} from '@/models/aspect-ratios';

type PlaybackShot = Pick<
  ShotView,
  'previewThumbnailUrl' | 'durationMs' | 'audioClips' | 'dialogue'
> & {
  video: { url: string | null } | null;
  image: { url: string | null } | null;
};

/** One continuous timeline: rendered clips where available, stills elsewhere. */
export function toPlaybackScenes(
  shots: readonly PlaybackShot[],
  aspectRatio: AspectRatio = '16:9'
): SceneInput[] {
  const scenes: SceneInput[] = [];
  for (const shot of shots) {
    const videoUrl = shot.video?.url;
    if (videoUrl) {
      const previous = scenes.at(-1);
      // Only adjacent rendered entries can share a packed clip.
      if (previous && 'videoUrl' in previous && previous.videoUrl === videoUrl)
        continue;
      scenes.push({ orderIndex: scenes.length, videoUrl });
    } else {
      scenes.push({
        orderIndex: scenes.length,
        imageUrl: shot.previewThumbnailUrl ?? shot.image?.url ?? null,
        fallbackImageUrl: shot.image?.url ?? null,
        durationSeconds:
          shot.durationMs != null && shot.durationMs > 0
            ? shot.durationMs / 1000
            : 3,
        audioUrls: (shot.audioClips ?? []).map((clip) => clip.url),
        ...aspectRatioToDimensions(aspectRatio),
        dialogue: shot.dialogue
          ? {
              ...shot.dialogue,
              lines: shot.dialogue.lines.map((line, index) => {
                const spoken = shot.audioClips
                  ?.flatMap((clip) => clip.spokenLines ?? [])
                  .find((spokenLine) => spokenLine.index === index)?.text;
                return spoken ? { ...line, line: spoken } : line;
              }),
            }
          : null,
        clip: shot.audioClips?.[0] ?? null,
      });
    }
  }
  return scenes;
}

/**
 * Packed in-clip renders (#1510) share one video URL across every covered
 * shot. Consecutive copies would play the clip twice; collapse them so the
 * stitch is one generation, not N.
 */
export function collapseConsecutiveUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    if (out[out.length - 1] !== url) out.push(url);
  }
  return out;
}

/**
 * Identity of a stitched clip list (order + URLs). A new `SceneInput[]` of
 * the same clips (shots refetch while others generate) is not a new list (#1284).
 */
export function scenePlaybackKey(scenes: readonly SceneInput[]): string {
  return JSON.stringify(
    scenes.map((scene) =>
      'videoUrl' in scene
        ? [scene.orderIndex, scene.videoUrl]
        : [
            scene.orderIndex,
            scene.imageUrl,
            scene.fallbackImageUrl,
            scene.durationSeconds,
            scene.audioUrls,
            scene.width,
            scene.height,
          ]
    )
  );
}
