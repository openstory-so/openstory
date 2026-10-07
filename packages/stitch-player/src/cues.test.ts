import { describe, expect, it } from 'vitest';
import { cueTextAt } from './cues';
import type { PlaybackClip } from './playback-clip';

const clips: PlaybackClip[] = [
  {
    orderIndex: 1,
    videoUrl: '/b.mp4',
    posterUrl: null,
    cues: [{ startSeconds: 0.5, endSeconds: 2, text: 'Second clip' }],
  },
  {
    orderIndex: 0,
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
];
// Measured: the still ran 4s, the clip starts at 4.
const offsets = [0, 4];

describe('cueTextAt', () => {
  it('places clip-local cues by orderIndex and measured offsets', () => {
    expect(cueTextAt(clips, offsets, 0.2)).toBe('Ann: Hello');
    expect(cueTextAt(clips, offsets, 4.6)).toBe('Second clip');
  });
  it('joins overlapping cues of one clip, one per line', () => {
    expect(cueTextAt(clips, offsets, 1.2)).toBe('Ann: Hello\nBob: Hi');
  });
  it('is null between cues, before measurement and on a clip without cues', () => {
    expect(cueTextAt(clips, offsets, 3.5)).toBeNull();
    expect(cueTextAt(clips, offsets, 4.1)).toBeNull();
    expect(cueTextAt(clips, [], 1)).toBeNull();
    expect(
      cueTextAt(
        [{ orderIndex: 0, videoUrl: '/a.mp4', posterUrl: null }],
        [0],
        1
      )
    ).toBeNull();
  });
});
