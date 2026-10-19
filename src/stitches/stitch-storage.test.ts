import { describe, expect, it } from 'vitest';
import { UPLOAD_EXTENSIONS } from '@/shots/server/upload-media';
import { STITCH_EXTENSIONS, stitchCutSchema } from './cut';
import {
  storedStitchCut,
  storedStitchPath,
  stitchUploadHref,
} from './server/stitch-storage';

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
    expect(storedStitchPath('/r2/stitches/TEAM/ID/0.png')).toBe(
      'TEAM/ID/0.png'
    );
    expect(() => storedStitchPath('/r2/talent/TEAM/x.png')).toThrow(
      'Not a stored stitch URL'
    );
  });

  it('templates the upload link on the team path', () => {
    expect(stitchUploadHref('TEAM', 'ID')).toBe(
      '/api/storage/upload?bucket=stitches&path=TEAM/ID/{name}&contentType={type}'
    );
  });

  it('refuses a cut whose media is not a bundle name', () => {
    const videoOnly = (videoUrl: string) => ({
      ...cut,
      clips: [{ videoUrl, posterUrl: null, cues: [] }],
    });
    expect(
      stitchCutSchema.safeParse(videoOnly('https://evil.example/x.mp4')).success
    ).toBe(false);
    expect(stitchCutSchema.safeParse(videoOnly('media/../x.mp4')).success).toBe(
      false
    );
    // Only what the player plays: no HTML, SVG or script under the name.
    expect(stitchCutSchema.safeParse(videoOnly('media/0.html')).success).toBe(
      false
    );
    expect(stitchCutSchema.safeParse(videoOnly('media/0.svg')).success).toBe(
      false
    );
    expect(stitchCutSchema.safeParse(videoOnly('media/0')).success).toBe(false);
  });

  it('accepts exactly the upload extensions, so the two lists cannot drift', () => {
    const server = [
      ...UPLOAD_EXTENSIONS.image,
      ...UPLOAD_EXTENSIONS.video,
      ...UPLOAD_EXTENSIONS.audio,
    ].sort();
    expect([...STITCH_EXTENSIONS].sort()).toEqual(server);
  });

  it('refuses a cue that ends before it starts', () => {
    const clip = cut.clips[0];
    if (!clip || !('imageUrl' in clip)) throw new Error('expected a still');
    const backwards = {
      ...cut,
      clips: [
        { ...clip, cues: [{ startSeconds: 5, endSeconds: 2, text: 'No' }] },
      ],
    };
    expect(stitchCutSchema.safeParse(backwards).success).toBe(false);
  });
});
