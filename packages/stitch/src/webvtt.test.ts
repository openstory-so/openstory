import { describe, expect, it } from 'vitest';
import { cuesToWebVTT } from './webvtt.js';

const still = {
  imageUrl: null,
  fallbackImageUrl: null,
  durationSeconds: 4,
  audioUrls: [],
  width: 1280,
  height: 720,
};

describe('cuesToWebVTT', () => {
  it('places clip-local cues on the stitched timeline, in time order', () => {
    const vtt = cuesToWebVTT(
      [
        {
          ...still,
          cues: [
            { startSeconds: 0.25, endSeconds: 1.5, text: 'Ann: Hello' },
            { startSeconds: 0, endSeconds: 0.2, text: 'Narration' },
          ],
        },
        {
          videoUrl: '/b.mp4',
          posterUrl: null,
          cues: [{ startSeconds: 0.5, endSeconds: 2, text: 'Bob: Later.' }],
        },
      ],
      [0, 61.25]
    );
    expect(vtt).toBe(
      [
        'WEBVTT',
        '00:00:00.000 --> 00:00:00.200\nNarration',
        '00:00:00.250 --> 00:00:01.500\nAnn: Hello',
        '00:01:01.750 --> 00:01:03.250\nBob: Later.',
      ].join('\n\n') + '\n'
    );
  });

  it('rounds to whole milliseconds, carrying into the seconds', () => {
    expect(
      cuesToWebVTT(
        [
          {
            ...still,
            cues: [{ startSeconds: 1.9996, endSeconds: 3600.0004, text: 'x' }],
          },
        ],
        [0]
      )
    ).toContain('00:00:02.000 --> 01:00:00.000');
  });

  it('is a header alone when nothing is said', () => {
    expect(
      cuesToWebVTT([{ videoUrl: '/a.mp4', posterUrl: null, cues: [] }], [0])
    ).toBe('WEBVTT\n');
  });

  it('refuses offsets that were not measured for these clips', () => {
    expect(() =>
      cuesToWebVTT([{ videoUrl: '/a.mp4', posterUrl: null, cues: [] }], [])
    ).toThrow('0 offsets for 1 clips');
  });
});
