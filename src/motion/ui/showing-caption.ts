/** A text track the shot player can read without touching the element. */
type CaptionCue = {
  readonly text?: string;
  readonly startTime: number;
  readonly endTime: number;
};

type CaptionCueList = {
  readonly length: number;
  [Symbol.iterator](): Iterator<CaptionCue>;
};

type CaptionTrack = {
  readonly kind: string;
  readonly mode: string;
  readonly cues: CaptionCueList | null;
};

/**
 * The line a captions track would paint at `currentTime`. Native cues do
 * not paint on the shot player's video, so the surface draws this string
 * itself. Chapters and a track that is not showing contribute nothing.
 */
export function showingCaptionText(
  tracks: ArrayLike<CaptionTrack> | null | undefined,
  currentTime: number
): string | null {
  if (!tracks) return null;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (!track) continue;
    if (track.kind !== 'captions' && track.kind !== 'subtitles') continue;
    if (track.mode !== 'showing') continue;
    const cues = track.cues;
    if (!cues || cues.length === 0) continue;
    const lines: string[] = [];
    for (const cue of cues) {
      if (
        cue.startTime <= currentTime &&
        currentTime < cue.endTime &&
        cue.text
      ) {
        lines.push(cue.text);
      }
    }
    if (lines.length > 0) return lines.join('\n');
  }
  return null;
}
