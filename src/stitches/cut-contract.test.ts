/**
 * The CLI's cut.json must parse under the server's cut schema (#2127): the
 * one contract `stitch share` rests on. A field renamed on either side fails
 * here instead of as a 400 on every share.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
  it('parses a still with cues and a frame', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-contract-'));
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'end.png'), png);
      const request = await parseArgs(
        [
          '--frame',
          '16:9',
          'board.png',
          '--fallback',
          'end.png',
          '--seconds',
          '3',
          '--cue',
          '0-2',
          'Hi',
          'end.png',
        ],
        cwd
      );
      if (request.kind !== 'play') throw new Error('expected a cut');
      const cut = await buildCut(request, bundledMediaUrl);
      const parsed = stitchCutSchema.parse(JSON.parse(cutJson(cut)));
      expect(parsed.clips).toHaveLength(2);
      expect(parsed.clips[0]).toMatchObject({
        imageUrl: 'media/0.png',
        fallbackImageUrl: 'media/1.png',
        durationSeconds: 3,
        cues: [{ startSeconds: 0, endSeconds: 2, text: 'Hi' }],
      });
      expect(parsed.frameWidth / parsed.frameHeight).toBeCloseTo(16 / 9);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
