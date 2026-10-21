import type { PlaybackCue } from './playback-clip.js';
import type { TimelineCue } from './subtitles.js';

/**
 * Puts whole-cut cues onto clips. A cue that crosses a cut is split there,
 * and each piece is stored in seconds from its clip's start.
 */
export function placeTimelineCues(
  durations: readonly number[],
  cues: readonly TimelineCue[]
): PlaybackCue[][] {
  if (durations.length === 0) {
    throw new Error('placeTimelineCues: at least one clip is required');
  }
  const placed = durations.map(() => [] as PlaybackCue[]);
  const offsets: number[] = [];
  let total = 0;
  for (const duration of durations) {
    if (!(duration > 0)) {
      throw new Error('placeTimelineCues: a clip needs a positive duration');
    }
    offsets.push(total);
    total += duration;
  }
  for (const cue of cues) {
    if (!(cue.startSeconds >= 0 && cue.startSeconds < cue.endSeconds)) {
      throw new Error(
        `subtitle cue needs 0 <= start < end, got ${cue.startSeconds}–${cue.endSeconds}`
      );
    }
    if (cue.startSeconds >= total) {
      throw new Error(
        `subtitle cue starts after the cut (${cue.startSeconds}s, cut is ${total}s)`
      );
    }
    if (cue.endSeconds > total + 1e-3) {
      throw new Error(
        `subtitle cue ends after the cut (${cue.endSeconds}s, cut is ${total}s)`
      );
    }
    const end = Math.min(cue.endSeconds, total);
    for (let i = 0; i < durations.length; i++) {
      const clipStart = offsets[i] ?? 0;
      const clipEnd = clipStart + (durations[i] ?? 0);
      const start = Math.max(cue.startSeconds, clipStart);
      const stop = Math.min(end, clipEnd);
      if (start < stop) {
        placed[i]?.push({
          startSeconds: start - clipStart,
          endSeconds: stop - clipStart,
          text: cue.text,
        });
      }
    }
  }
  return placed;
}
