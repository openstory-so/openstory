import type { PlaybackClip } from './playback-clip.js';

function timestamp(seconds: number): string {
  // Round to whole milliseconds first: rounding the fraction on its own
  // gives 1000 ms for 1.9996 s, which is not a WebVTT timestamp.
  const totalMs = Math.round(seconds * 1000);
  const whole = Math.floor(totalMs / 1000);
  const h = String(Math.floor(whole / 3600)).padStart(2, '0');
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const s = String(whole % 60).padStart(2, '0');
  const ms = String(totalMs % 1000).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * The clips' cues as one WebVTT document on the stitched timeline — the
 * subtitle sidecar for an export. `clipOffsetsSeconds` is the measured
 * start of each clip, one per clip in order, as `prepare()` reports it.
 */
export function cuesToWebVTT(
  clips: readonly PlaybackClip[],
  clipOffsetsSeconds: readonly number[]
): string {
  if (clipOffsetsSeconds.length !== clips.length) {
    throw new Error(
      `cuesToWebVTT: ${clipOffsetsSeconds.length} offsets for ${clips.length} clips`
    );
  }
  const cues = clips.flatMap((clip, i) => {
    const offset = clipOffsetsSeconds[i] ?? 0;
    return clip.cues.map((cue) => ({
      start: offset + cue.startSeconds,
      end: offset + cue.endSeconds,
      text: cue.text,
    }));
  });
  cues.sort((a, b) => a.start - b.start);
  const blocks = cues.map(
    (cue) => `${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}`
  );
  return ['WEBVTT', ...blocks].join('\n\n') + '\n';
}
