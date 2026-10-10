import { describe, expect, it } from 'vitest';
import { cueTextAt } from './cues.js';
import type { PlaybackClip } from './playback-clip.js';

const clips: PlaybackClip[] = [
  {
    imageUrl: null,
    fallbackImageUrl: null,
    durationSeconds: 4,
    audioUrls: [],
    width: 1280,
    height: 720,
    cues: [
      { startSeconds: 0, endSeconds: 1.5, text: 'Ann: Hello' },
      { startSeconds: 1, endSeconds: 3, text: 'Bob: Hi' },
    ],
  },
  {
    videoUrl: '/b.mp4',
    posterUrl: null,
    cues: [{ startSeconds: 0.5, endSeconds: 2, text: 'Second clip' }],
  },
];
// Measured: the still ran 4s, the clip starts at 4.
const offsets = [0, 4];

describe('cueTextAt', () => {
  it('places clip-local cues by array order and measured offsets', () => {
    expect(cueTextAt(clips, offsets, 0.2)).toBe('Ann: Hello');
    expect(cueTextAt(clips, offsets, 4.6)).toBe('Second clip');
  });
  it('joins overlapping cues of one clip, one per line', () => {
    expect(cueTextAt(clips, offsets, 1.2)).toBe('Ann: Hello\nBob: Hi');
  });
  it('is null between cues and on a clip without cues', () => {
    expect(cueTextAt(clips, offsets, 3.5)).toBeNull();
    expect(cueTextAt(clips, offsets, 4.1)).toBeNull();
    expect(
      cueTextAt([{ videoUrl: '/a.mp4', posterUrl: null, cues: [] }], [0], 1)
    ).toBeNull();
  });
  it('refuses offsets that were not measured for these clips', () => {
    expect(() => cueTextAt(clips, [0], 1)).toThrow('1 offsets for 2 clips');
  });
});
