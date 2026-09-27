import type { SceneInput } from './concatenated-video-source';

import type { ShotView } from '@/shots/shot-view';
import {
  packedClipWindows,
  shotIdAtTime,
  type PackedClipShot,
} from '@/shots/packed-clip-window';
import {
  aspectRatioToDimensions,
  type AspectRatio,
} from '@/models/aspect-ratios';

type PlaybackShot = Pick<
  ShotView,
  'previewThumbnailUrl' | 'durationMs' | 'audioClips'
> & {
  video: { url: string | null } | null;
  image: { url: string | null } | null;
};

/**
 * Shots per playback scene, in order. Adjacent shots that share a rendered
 * clip (a packed render, #1510) are one scene; every other shot is its own.
 */
export function groupPlaybackShots<
  S extends { video: { url: string | null } | null },
>(shots: readonly S[]): S[][] {
  const groups: S[][] = [];
  for (const shot of shots) {
    const url = shot.video?.url;
    const previous = groups.at(-1);
    if (url && previous?.[0]?.video?.url === url) previous.push(shot);
    else groups.push([shot]);
  }
  return groups;
}

/** One continuous timeline: rendered clips where available, stills elsewhere. */
export function toPlaybackScenes(
  shots: readonly PlaybackShot[],
  aspectRatio: AspectRatio = '16:9'
): SceneInput[] {
  const scenes: SceneInput[] = [];
  for (const group of groupPlaybackShots(shots)) {
    const shot = group[0];
    if (!shot) continue;
    const videoUrl = shot.video?.url;
    const stillUrl = shot.image?.url ?? null;
    const previewUrl = shot.previewThumbnailUrl ?? null;
    if (videoUrl) {
      scenes.push({
        orderIndex: scenes.length,
        videoUrl,
        posterUrl: stillUrl ?? previewUrl,
      });
    } else {
      scenes.push({
        orderIndex: scenes.length,
        imageUrl: stillUrl ?? previewUrl,
        fallbackImageUrl:
          stillUrl && previewUrl && previewUrl !== stillUrl ? previewUrl : null,
        durationSeconds:
          shot.durationMs != null && shot.durationMs > 0
            ? shot.durationMs / 1000
            : 3,
        audioUrls: (shot.audioClips ?? []).map((clip) => clip.url),
        ...aspectRatioToDimensions(aspectRatio),
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

/**
 * Which shot the sequence player is on at `time` (#1771). Scene boundaries
 * are the stitcher's measured offsets when it has them. Inside a packed
 * clip, shots split the scene in their own `durationMs` proportions, so a clip that came back a little
 * longer than asked still lands on the right shot.
 */
export function shotIdAtSequenceTime<
  S extends PackedClipShot & { video: { url: string | null } | null },
>(
  shots: readonly S[],
  time: number,
  /** The measured start of each playback scene, when known. */
  sceneOffsetsSeconds?: readonly number[]
): string | undefined {
  const scenes = groupPlaybackShots(shots).map((group) =>
    packedClipWindows(group)
  );
  let cursor = 0;
  for (const [index, windows] of scenes.entries()) {
    const estimated = windows.at(-1)?.endSeconds ?? 0;
    const start = sceneOffsetsSeconds?.[index] ?? cursor;
    const end = sceneOffsetsSeconds?.[index + 1] ?? start + estimated;
    if (time < end) {
      const local =
        end > start ? ((time - start) / (end - start)) * estimated : 0;
      return shotIdAtTime(windows, local);
    }
    cursor = end;
  }
  return shots.at(-1)?.id;
}
