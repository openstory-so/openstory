/** A subtitle over part of one clip, in seconds from that clip's start. */
export type PlaybackCue = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

/** One stitched entry: a rendered clip, or a timed still. */
export type PlaybackClip = {
  orderIndex: number;
  /** Subtitles for this clip. Shown by the Video.js / React entries; the engine ignores them. */
  cues?: PlaybackCue[];
} & (
  | {
      videoUrl: string;
      /**
       * The shot's still — what the clip opens on — shown while the player
       * warms up. Not the clip itself: a hidden `<video>` would download it
       * beside the player's own reads.
       */
      posterUrl: string | null;
    }
  | {
      imageUrl: string | null;
      fallbackImageUrl: string | null;
      durationSeconds: number;
      /** Sound played over the still, back to back. Each must answer Range requests, or be a `data:` / `blob:` URL. */
      audioUrls: string[];
      width: number;
      height: number;
    }
);
