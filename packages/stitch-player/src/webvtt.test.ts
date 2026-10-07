import { describe, expect, it } from 'vitest';
import { cuesToWebVTT } from './webvtt';

describe('cuesToWebVTT', () => {
  it('places clip-local cues on the stitched timeline, in time order', () => {
    const vtt = cuesToWebVTT(
      [
        {
          orderIndex: 1,
          videoUrl: '/b.mp4',
          posterUrl: null,
          cues: [{ startSeconds: 0.5, endSeconds: 2, text: 'Bob: Later.' }],
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
            { startSeconds: 0.25, endSeconds: 1.5, text: 'Ann: Hello' },
            { startSeconds: 0, endSeconds: 0.2, text: 'Narration' },
          ],
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

  it('is a header alone when nothing is said', () => {
    expect(
      cuesToWebVTT(
        [{ orderIndex: 0, videoUrl: '/a.mp4', posterUrl: null }],
        [0]
      )
    ).toBe('WEBVTT\n');
  });
});
