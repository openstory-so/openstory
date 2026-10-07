import type { PlaybackClip } from './playback-clip';

function timestamp(seconds: number): string {
  const whole = Math.floor(seconds);
  const h = String(Math.floor(whole / 3600)).padStart(2, '0');
  const m = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  const s = String(whole % 60).padStart(2, '0');
  const ms = String(Math.round((seconds - whole) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/**
 * The clips' cues as one WebVTT document on the stitched timeline — the
 * subtitle sidecar for an export. `clipOffsetsSeconds` is the measured
 * start of each clip, in `orderIndex` order, as `prepare()` reports it.
 */
export function cuesToWebVTT(
  clips: readonly PlaybackClip[],
  clipOffsetsSeconds: readonly number[]
): string {
  const sorted = [...clips].sort((a, b) => a.orderIndex - b.orderIndex);
  const cues = sorted.flatMap((clip, i) => {
    const offset = clipOffsetsSeconds[i];
    if (offset === undefined) return [];
    return (clip.cues ?? []).map((cue) => ({
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
