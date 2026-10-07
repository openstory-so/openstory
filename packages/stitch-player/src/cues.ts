import type { PlaybackClip } from './playback-clip';

/**
 * The subtitle to show at `time` on the stitched timeline, or null. Cues are
 * clip-local; `clipOffsetsSeconds` (measured by the engine, in `orderIndex`
 * order) places them. Cues of one clip that overlap are shown together, in
 * order, one per line.
 */
export function cueTextAt(
  clips: readonly PlaybackClip[],
  clipOffsetsSeconds: readonly number[],
  time: number
): string | null {
  const sorted = [...clips].sort((a, b) => a.orderIndex - b.orderIndex);
  let index = -1;
  for (let i = 0; i < clipOffsetsSeconds.length; i++) {
    const offset = clipOffsetsSeconds[i];
    if (offset !== undefined && time >= offset) index = i;
  }
  const clip = sorted[index];
  const offset = clipOffsetsSeconds[index];
  if (!clip?.cues || offset === undefined) return null;
  const local = time - offset;
  const texts = clip.cues
    .filter((cue) => local >= cue.startSeconds && local < cue.endSeconds)
    .map((cue) => cue.text);
  return texts.length > 0 ? texts.join('\n') : null;
}
