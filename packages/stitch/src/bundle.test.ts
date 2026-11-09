import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./video-size.js', () => ({
  isHttpUrl: (file: string) => /^https?:\/\//i.test(file),
  readVideoDisplaySize: async () => ({
    width: 480,
    height: 854,
    durationSeconds: 4,
  }),
  readAudioDuration: async () => 5,
}));
import { buildCut, bundledMediaUrl, parseArgs, writeBundle } from './cli.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function cutIn(cwd: string) {
  await writeFile(join(cwd, 'board.png'), png);
  await writeFile(join(cwd, 'line.wav'), 'line');
  await writeFile(join(cwd, 'shot.mp4'), 'video');
  const request = await parseArgs(
    ['board.png', '--audio', 'line.wav', 'shot.mp4', '--music', 'line.wav'],
    cwd
  );
  if (request.kind !== 'play') throw new Error('expected a cut');
  return buildCut(request, bundledMediaUrl);
}

describe('stitch bundle', () => {
  it('parses the directory and names media by extension', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-bundle-'));
    try {
      await writeFile(join(cwd, 'board.png'), png);
      const request = await parseArgs(['bundle', 'out', 'board.png'], cwd);
      expect(request).toMatchObject({ kind: 'bundle', dir: join(cwd, 'out') });
      const cut = await cutIn(cwd);
      expect(cut.clips[0]).toMatchObject({
        imageUrl: 'media/0.png',
        audioUrls: ['media/1.wav'],
      });
      expect(cut.clips[1]).toMatchObject({ videoUrl: 'media/2.mp4' });
      // The music is the same file as the line: one copy, one URL.
      expect(cut.musicUrl).toBe('media/1.wav');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes the page, cut.json, and every file under media/', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-bundle-'));
    try {
      const pageDir = join(cwd, 'page');
      await writeFile(join(cwd, 'x'), '');
      await rm(join(cwd, 'x'));
      await writeFile(join(cwd, 'board.png'), png);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(pageDir);
      await writeFile(join(pageDir, 'index.html'), '<p>stitch</p>');
      const cut = await cutIn(cwd);
      const dir = join(cwd, 'out');
      await writeBundle({ cut, dir, pageDir });
      expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe(
        '<p>stitch</p>'
      );
      expect(await readFile(join(dir, 'media', '2.mp4'), 'utf8')).toBe('video');
      const written = JSON.parse(await readFile(join(dir, 'cut.json'), 'utf8'));
      expect(written.clips[0].imageUrl).toBe('media/0.png');
      expect(written.frameWidth).toBe(1);
      expect(written.files).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
