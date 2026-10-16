import { describe, expect, it } from 'vitest';
import { stitchCutSchema } from './cut';
import { storedStitchCut, stitchUploadHref } from './server/stitch-storage';

const cut = stitchCutSchema.parse({
  clips: [
    {
      imageUrl: 'media/0.png',
      fallbackImageUrl: null,
      durationSeconds: 3,
      audioUrls: ['media/1.wav'],
      width: 1024,
      height: 576,
      cues: [{ startSeconds: 0, endSeconds: 2, text: 'Hi' }],
    },
    { videoUrl: 'media/2.mp4', posterUrl: 'media/0.png', cues: [] },
  ],
  frameWidth: 16,
  frameHeight: 9,
  musicUrl: 'media/1.wav',
  musicGainDb: -3,
});

describe('shared stitch storage', () => {
  it('rewrites every bundle name to the team path under the stitch id', () => {
    const stored = storedStitchCut(cut, 'TEAM', 'ID');
    expect(stored.clips[0]).toMatchObject({
      imageUrl: '/r2/stitches/TEAM/ID/0.png',
      audioUrls: ['/r2/stitches/TEAM/ID/1.wav'],
    });
    expect(stored.clips[1]).toMatchObject({
      videoUrl: '/r2/stitches/TEAM/ID/2.mp4',
      posterUrl: '/r2/stitches/TEAM/ID/0.png',
    });
    expect(stored.musicUrl).toBe('/r2/stitches/TEAM/ID/1.wav');
    expect(stored.musicGainDb).toBe(-3);
  });

  it('templates the upload link on the team path', () => {
    expect(stitchUploadHref('TEAM', 'ID')).toBe(
      '/api/storage/upload?bucket=stitches&path=TEAM/ID/{name}&contentType={type}'
    );
  });

  it('refuses a cut whose media is not a bundle name', () => {
    const outside = {
      ...cut,
      clips: [
        { videoUrl: 'https://evil.example/x.mp4', posterUrl: null, cues: [] },
      ],
    };
    expect(stitchCutSchema.safeParse(outside).success).toBe(false);
    const traversal = {
      ...cut,
      clips: [{ videoUrl: 'media/../x.mp4', posterUrl: null, cues: [] }],
    };
    expect(stitchCutSchema.safeParse(traversal).success).toBe(false);
  });
});
