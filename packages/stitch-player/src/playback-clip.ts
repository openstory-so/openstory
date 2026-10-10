/**
 * A subtitle over part of one clip, in seconds from that clip's start.
 * `0 <= startSeconds < endSeconds`; checked when the clips are opened.
 */
export type PlaybackCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

/**
 * One stitched entry: a rendered clip, or a timed still. Clips play in array
 * order. Invariants on a still (positive duration and size) are checked by
 * `ConcatenatedVideoSource` when it opens the list; a bad clip is an error,
 * not a skipped entry.
 */
export type PlaybackClip = {
  /** Subtitles for this clip; `[]` for none. Shown by the Video.js / React entries; the engine ignores them. */
  cues: readonly PlaybackCue[];
} & (
  | {
      videoUrl: string;
      /**
       * Optional still for a host to show while it waits for the first frame.
       * This package does not paint it. Not the clip itself: a hidden
       * `<video>` would download it beside the player's own reads.
       */
      posterUrl: string | null;
    }
  | {
      /** Null when there is no picture yet: the slot holds for its duration on a dark frame. */
      imageUrl: string | null;
      /** Tried when `imageUrl` fails to load. */
      fallbackImageUrl: string | null;
      /** How long the still holds when it has no sound; with `audioUrls` it runs as long as the sound. */
      durationSeconds: number;
      /** Sound played over the still, back to back. Each must answer Range requests, or be a `data:` / `blob:` URL. */
      audioUrls: readonly string[];
      width: number;
      height: number;
    }
);

/** Throws when a clip breaks an invariant the engine relies on. */
export function assertPlaybackClips(clips: readonly PlaybackClip[]): void {
  if (clips.length === 0) throw new Error('At least one clip is required');
  clips.forEach((clip, i) => {
    if (!('videoUrl' in clip)) {
      if (!(clip.durationSeconds > 0)) {
        throw new Error(`Clip ${i}: a still needs a positive durationSeconds`);
      }
      if (!(clip.width > 0 && clip.height > 0)) {
        throw new Error(`Clip ${i}: a still needs a positive width and height`);
      }
    }
    for (const cue of clip.cues) {
      if (!(cue.startSeconds >= 0 && cue.startSeconds < cue.endSeconds)) {
        throw new Error(
          `Clip ${i}: cue "${cue.text}" needs 0 <= start < end, got ${cue.startSeconds}–${cue.endSeconds}`
        );
      }
    }
  });
}
