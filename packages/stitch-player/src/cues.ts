import type { PlaybackClip } from './playback-clip.js';

/**
 * The subtitle to show at `time` on the stitched timeline, or null. Cues are
 * clip-local; `clipOffsetsSeconds` (measured by the engine, one per clip in
 * order) places them. Cues of one clip that overlap are shown together, in
 * order, one per line.
 */
export function cueTextAt(
  clips: readonly PlaybackClip[],
  clipOffsetsSeconds: readonly number[],
  time: number
): string | null {
  if (clipOffsetsSeconds.length !== clips.length) {
    throw new Error(
      `cueTextAt: ${clipOffsetsSeconds.length} offsets for ${clips.length} clips`
    );
  }
  let index = -1;
  for (let i = 0; i < clipOffsetsSeconds.length; i++) {
    const offset = clipOffsetsSeconds[i];
    if (offset !== undefined && time >= offset) index = i;
  }
  const clip = clips[index];
  const offset = clipOffsetsSeconds[index];
  if (!clip || offset === undefined) return null;
  const local = time - offset;
  const texts = clip.cues
    .filter((cue) => local >= cue.startSeconds && local < cue.endSeconds)
    .map((cue) => cue.text);
  return texts.length > 0 ? texts.join('\n') : null;
}
