import type { PlaybackClip } from './playback-clip.js';

/**
 * Identity of a stitched clip list (order + media). A new `PlaybackClip[]`
 * of the same clips is not a new list, so a refetch never rebuilds a playing
 * engine. Cues are not media: they change without a rebuild.
 */
export function playbackClipsKey(clips: readonly PlaybackClip[]): string {
  return JSON.stringify(
    clips.map((clip) =>
      'videoUrl' in clip
        ? [clip.videoUrl]
        : [
            clip.imageUrl,
            clip.fallbackImageUrl,
            clip.durationSeconds,
            clip.audioUrls,
            clip.width,
            clip.height,
          ]
    )
  );
}
