/**
 * The CLI's cut.json must parse under the server's cut schema (#2127): the
 * one contract `stitch share` rests on. A field renamed on either side fails
 * here instead of as a 400 on every share.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The CLI probes a clip's size and a line's length with mediabunny; the
// contract is the JSON shape, so the probes answer fixed numbers.
vi.mock('../../packages/stitch/src/video-size.js', () => ({
  isHttpUrl: (file: string) => /^https?:\/\//i.test(file),
  readVideoDisplaySize: async () => ({
    width: 1920,
    height: 1080,
    durationSeconds: 4,
  }),
  readAudioDuration: async () => 5,
}));
import {
  buildCut,
  bundledMediaUrl,
  cutJson,
  parseArgs,
} from '../../packages/stitch/src/cli.js';
import { stitchCutSchema } from './cut';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('stitch CLI cut.json against stitchCutSchema', () => {
  it('parses a video with poster, a still with a line and cues, and a music bed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-contract-'));
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'end.png'), png);
      await writeFile(join(cwd, 'shot.mp4'), 'video');
      await writeFile(join(cwd, 'line.wav'), 'line');
      await writeFile(join(cwd, 'score.mp3'), 'music');
      const request = await parseArgs(
        [
          '--frame',
          '16:9',
          '--music',
          'score.mp3',
          '--music-gain',
          '-3',
          'shot.mp4',
          '--poster',
          'board.png',
          '--cue',
          '0-1.5',
          'Go',
          'board.png',
          '--fallback',
          'end.png',
          '--audio',
          'line.wav',
          '--seconds',
          '3',
          '--cue',
          '0-2',
          'Hi',
        ],
        cwd
      );
      if (request.kind !== 'play') throw new Error('expected a cut');
      const cut = await buildCut(request, bundledMediaUrl);
      const parsed = stitchCutSchema.parse(JSON.parse(cutJson(cut)));
      expect(parsed.clips).toHaveLength(2);
      expect(parsed.clips[0]).toMatchObject({
        videoUrl: 'media/0.mp4',
        posterUrl: 'media/1.png',
        cues: [{ startSeconds: 0, endSeconds: 1.5, text: 'Go' }],
      });
      expect(parsed.clips[1]).toMatchObject({
        imageUrl: 'media/1.png',
        fallbackImageUrl: 'media/2.png',
        audioUrls: ['media/3.wav'],
        durationSeconds: 3,
        cues: [{ startSeconds: 0, endSeconds: 2, text: 'Hi' }],
      });
      expect(parsed.musicUrl).toBe('media/4.mp3');
      expect(parsed.musicGainDb).toBe(-3);
      expect(parsed.frameWidth / parsed.frameHeight).toBeCloseTo(16 / 9);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
