import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installSkill,
  main,
  packageRoot,
  parseArgs,
  serveCut,
  startPreview,
  usage,
} from './cli.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function tempDir(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('stitch arguments', () => {
  it('reads a still, its line, a video, and music', async () => {
    const cwd = await tempDir('stitch-cut-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'line.wav'), 'line');
      await writeFile(join(cwd, 'shot.mp4'), 'video');
      await writeFile(join(cwd, 'score.mp3'), 'music');
      const request = await parseArgs(
        [
          '--music',
          'score.mp3',
          '--music-gain',
          '-3',
          'board.png',
          '--audio',
          'line.wav',
          '--seconds',
          '3',
          '--cue',
          '0-2',
          'Coming over?',
          'shot.mp4',
          '--cue',
          '0-1.5',
          'Love that accent.',
          '--no-open',
        ],
        cwd
      );
      expect(request.kind).toBe('play');
      if (request.kind !== 'play') return;
      expect(request.musicGainDb).toBe(-3);
      expect(request.open).toBe(false);
      expect(request.clips[0]).toMatchObject({
        kind: 'still',
        seconds: 3,
        width: 1,
        height: 1,
        cues: [{ startSeconds: 0, endSeconds: 2, text: 'Coming over?' }],
      });
      expect(request.clips[1]).toMatchObject({
        kind: 'video',
        cues: [{ startSeconds: 0, endSeconds: 1.5, text: 'Love that accent.' }],
      });

      const served = await serveCut(request);
      expect(served.clips[0]).toMatchObject({
        imageUrl: '/media/0',
        audioUrls: ['/media/1'],
        durationSeconds: 3,
      });
      expect(served.clips[1]).toMatchObject({
        videoUrl: '/media/2',
        posterUrl: null,
      });
      expect(served.musicUrl).toBe('/media/3');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('refuses dialogue on a video', async () => {
    const cwd = await tempDir('stitch-video-');
    try {
      await writeFile(join(cwd, 'shot.mp4'), 'video');
      await writeFile(join(cwd, 'line.wav'), 'line');
      await expect(
        parseArgs(['shot.mp4', '--audio', 'line.wav'], cwd)
      ).rejects.toThrow(/belongs on a still/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects an unknown flag', async () => {
    await expect(parseArgs(['--nope'], tmpdir())).rejects.toThrow(
      /Unknown argument: --nope/
    );
  });
});

describe('stitch preview', () => {
  it('serves the cut and a byte range of a file', async () => {
    const cwd = await tempDir('stitch-serve-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'index.html'), '<p>stitch</p>');
      const request = await parseArgs(['board.png', '--no-open'], cwd);
      if (request.kind !== 'play') throw new Error('expected a cut');
      const served = await serveCut(request);
      const preview = await startPreview({ served, pageDir: cwd, port: 0 });
      try {
        const page = await fetch(preview.url);
        expect(await page.text()).toContain('stitch');
        const cut = await fetch(new URL('/cut.json', preview.url)).then(
          (response) => response.text()
        );
        expect(cut).toContain('"imageUrl":"/media/0"');
        const media = await fetch(new URL('/media/0', preview.url), {
          headers: { Range: 'bytes=0-3' },
        });
        expect(media.status).toBe(206);
        expect(media.headers.get('content-range')).toBe(
          `bytes 0-3/${png.length}`
        );
        expect(Buffer.from(await media.arrayBuffer())).toEqual(
          png.subarray(0, 4)
        );
      } finally {
        await preview.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('stitch skill', () => {
  it('installs the skill that agents load as /stitch', async () => {
    const cwd = await tempDir('stitch-skill-');
    try {
      const dest = await installSkill({
        cwd,
        home: cwd,
        global: false,
        packageRoot: packageRoot(),
      });
      const skill = await readFile(join(dest, 'SKILL.md'), 'utf8');
      expect(skill).toContain('name: stitch');
      expect(skill).toContain('user-invocable: true');
      const stdout: string[] = [];
      process.exitCode = undefined;
      await main(['--help'], {
        stdout: { write: (text) => stdout.push(text) },
      });
      expect(stdout.join('')).toBe(usage);
      expect(process.exitCode).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
