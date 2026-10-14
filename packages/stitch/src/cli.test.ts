import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./video-size.js', () => ({
  readVideoDisplaySize: async () => ({
    width: 480,
    height: 854,
    durationSeconds: 4,
  }),
  readAudioDuration: async () => 5,
}));
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
      expect(served.frameWidth).toBe(480);
      expect(served.frameHeight).toBe(854);
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

  it('places a subtitle file on the clips it covers', async () => {
    const cwd = await tempDir('stitch-subs-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'shot.mp4'), 'video');
      await writeFile(
        join(cwd, 'lines.srt'),
        '1\n00:00:01,000 --> 00:00:02,000\nOn the still\n\n2\n00:00:02,500 --> 00:00:03,500\nAcross\n'
      );
      const request = await parseArgs(
        [
          'board.png',
          '--seconds',
          '3',
          'shot.mp4',
          '--subs',
          'lines.srt',
          '--no-open',
        ],
        cwd
      );
      if (request.kind !== 'play') throw new Error('expected a cut');
      const served = await serveCut(request);
      expect(served.clips[0]?.cues).toEqual([
        { startSeconds: 1, endSeconds: 2, text: 'On the still' },
        { startSeconds: 2.5, endSeconds: 3, text: 'Across' },
      ]);
      expect(served.clips[1]?.cues).toEqual([
        { startSeconds: 0, endSeconds: 0.5, text: 'Across' },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('attaches a poster to a video and a fallback to a still', async () => {
    const cwd = await tempDir('stitch-poster-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'other.png'), png);
      await writeFile(join(cwd, 'shot.mp4'), 'video');
      const request = await parseArgs(
        [
          'shot.mp4',
          '--poster',
          'board.png',
          'other.png',
          '--fallback',
          'board.png',
        ],
        cwd
      );
      if (request.kind !== 'play') throw new Error('expected a cut');
      expect(request.clips[0]).toMatchObject({ kind: 'video' });
      expect(request.clips[1]).toMatchObject({
        kind: 'still',
        fallback: join(cwd, 'board.png'),
      });
      if (request.clips[0]?.kind !== 'video') return;
      expect(request.clips[0].poster).toBe(join(cwd, 'board.png'));
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
        expect(cut).toContain('"frameWidth":2');
        expect(cut).toContain('"frameHeight":2');
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
      const dests = await installSkill({
        cwd,
        home: cwd,
        global: false,
        packageRoot: packageRoot(),
      });
      const stitch = await readFile(join(dests[0] ?? '', 'SKILL.md'), 'utf8');
      const player = await readFile(join(dests[1] ?? '', 'SKILL.md'), 'utf8');
      expect(dests.map((dest) => dest.split('/').pop())).toEqual([
        'stitch',
        'stitch-player',
      ]);
      expect(stitch).toContain('name: stitch');
      expect(stitch).toContain('user-invocable: true');
      expect(player).toContain('name: stitch-player');
      expect(player).toContain('@openstory/stitch');
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
