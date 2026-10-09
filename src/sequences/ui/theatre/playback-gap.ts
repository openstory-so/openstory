import type { SequencePlayerMeta } from '@openstory/stitch-player';

function clipList(indexes: readonly number[]): string {
  const names = indexes.map((index) => `clip ${index + 1}`);
  if (names.length <= 1) return names[0] ?? '';
  const last = names[names.length - 1];
  return `${names.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * What the theatre says when a cut plays with a hole: no score, a silent
 * clip, or a dark still. Null when there is nothing to warn about. An
 * in-browser export refuses the same holes; this warning is the one the
 * viewer sees while playback continues.
 */
export function playbackGapMessage(
  meta: Pick<
    SequencePlayerMeta,
    'musicUndecodable' | 'silentClipIndexes' | 'missingStillIndexes'
  >
): string | null {
  const parts: string[] = [];
  if (meta.musicUndecodable) {
    parts.push('This browser cannot play the music, so the score is silent.');
  }
  if (meta.silentClipIndexes.length > 0) {
    const clips = clipList(meta.silentClipIndexes);
    const pronoun =
      meta.silentClipIndexes.length === 1 ? 'it plays' : 'they play';
    parts.push(
      `This browser cannot play the sound on ${clips}, so ${pronoun} silent.`
    );
  }
  if (meta.missingStillIndexes.length > 0) {
    const clips = clipList(meta.missingStillIndexes);
    const verb = meta.missingStillIndexes.length === 1 ? 'has' : 'have';
    const pronoun =
      meta.missingStillIndexes.length === 1 ? 'it holds' : 'they hold';
    const title = clips.charAt(0).toUpperCase() + clips.slice(1);
    parts.push(`${title} ${verb} no picture, so ${pronoun} on a dark frame.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
