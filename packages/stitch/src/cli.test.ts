import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const readVideoDisplaySize = vi.hoisted(() =>
  vi.fn(async () => ({ width: 480, height: 854, durationSeconds: 4 }))
);
vi.mock('./video-size.js', () => ({
  isHttpUrl: (file: string) => /^https?:\/\//i.test(file),
  readVideoDisplaySize,
  readAudioDuration: async (file: string) => {
    if (file.includes('bad')) throw new Error(`${file} has no audio track`);
    return 5;
  },
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
      // The first clip, a still, sets the box. The video is not read.
      expect(served.frameWidth).toBe(1);
      expect(served.frameHeight).toBe(1);
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

  it('keeps cue text that starts with a dash', async () => {
    const cwd = await tempDir('stitch-dash-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      const request = await parseArgs(
        ['board.png', '--cue', '0-2', '- I know.'],
        cwd
      );
      if (request.kind !== 'play') throw new Error('expected a cut');
      expect(request.clips[0]?.cues).toEqual([
        { startSeconds: 0, endSeconds: 2, text: '- I know.' },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    [['--poster', 'board.png'], /comes after the clip/],
    [['board.png', '--poster', 'board.png'], /--poster belongs on a video/],
    [
      ['board.png', 'shot.mp4', '--poster', 'board.png'],
      /--poster belongs on the first clip/,
    ],
    [['shot.mp4', '--poster', 'notes.txt'], /not a png, jpg, jpeg, or webp/],
    [['board.png', '--fallback', 'broken.png'], /broken\.png: the png header/],
    [['--cue', '0-1', 'hi'], /comes after the clip/],
    [['board.png', '--cue', '2-1', 'hi'], /0 <= start < end/],
    [['board.png', '--cue', '0-2'], /needs a range and text/],
    [['board.png', '--seconds', '0'], /positive number/],
    [['board.png', '--port', '70000'], /port number/],
    [['board.png', '--port', 'abc'], /port number/],
    [['board.png', '--frame', '16x'], /--frame needs a ratio/],
    [['board.png', '--frame', '0:9'], /--frame needs a ratio/],
    [
      ['board.png', '--frame', '9:16', '--frame', '1:1'],
      /--frame is already set/,
    ],
    [['board.png', '--subs', 'notes.txt'], /\.srt or \.vtt/],
    [['board.png', '--music', 'bad.mp3'], /bad\.mp3 has no audio track/],
    [['board.png', '--audio', 'bad.wav'], /bad\.wav has no audio track/],
    [['missing.png'], /missing\.png does not exist/],
    [['folder'], /folder is not a file/],
    [['notes.txt'], /not a still or a video/],
    [['broken.png'], /broken\.png: the png header is unreadable/],
    [[], /at least one still or video/],
  ])('refuses %j', async (argv, error) => {
    const cwd = await tempDir('stitch-refuse-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'broken.png'), png.subarray(0, 12));
      await writeFile(join(cwd, 'shot.mp4'), 'video');
      await writeFile(join(cwd, 'notes.txt'), 'notes');
      await writeFile(join(cwd, 'bad.mp3'), 'music');
      await writeFile(join(cwd, 'bad.wav'), 'line');
      await mkdir(join(cwd, 'folder'));
      await expect(parseArgs(argv, cwd)).rejects.toThrow(error);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('places --subs by the still hold, which a long line extends', async () => {
    const cwd = await tempDir('stitch-subs-hold-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'line.wav'), 'line');
      await writeFile(
        join(cwd, 'lines.srt'),
        '1\n00:00:04,000 --> 00:00:04,500\nStill talking\n'
      );
      const request = await parseArgs(
        [
          '--subs',
          'lines.srt',
          'board.png',
          '--seconds',
          '3',
          '--audio',
          'line.wav',
          'board.png',
        ],
        cwd
      );
      if (request.kind !== 'play') throw new Error('expected a cut');
      const served = await serveCut(request);
      expect(served.clips[0]?.cues).toEqual([
        { startSeconds: 4, endSeconds: 4.5, text: 'Still talking' },
      ]);
      expect(served.clips[1]?.cues).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
        expect(cut).toContain('"frameWidth":1');
        expect(cut).toContain('"frameHeight":1');
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

describe('stitch preview requests', () => {
  const body = Buffer.from('012345678');

  async function withPreview(
    run: (url: string) => Promise<void>
  ): Promise<void> {
    const cwd = await tempDir('stitch-range-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'index.html'), '<p>stitch</p>');
      await mkdir(join(cwd, 'assets'));
      const request = await parseArgs(['board.png'], cwd);
      if (request.kind !== 'play') throw new Error('expected a cut');
      const served = await serveCut(request);
      // Serve a known 9-byte body as /media/0.
      await writeFile(join(cwd, 'body.bin'), body);
      const files = new Map([['0', join(cwd, 'body.bin')]]);
      const preview = await startPreview({
        served: { ...served, files },
        pageDir: cwd,
        port: 0,
        stderr: { write: () => {} },
      });
      try {
        await run(preview.url);
      } finally {
        await preview.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it.each([
    ['bytes=0-9999', 206, 'bytes 0-8/9', '012345678'],
    ['bytes=-3', 206, 'bytes 6-8/9', '678'],
    ['bytes=5-', 206, 'bytes 5-8/9', '5678'],
    ['bytes=99-', 416, 'bytes */9', ''],
    ['bytes=0-1,4-5', 416, 'bytes */9', ''],
    ['bytes=5-2', 416, 'bytes */9', ''],
  ])('answers Range %s', async (range, status, contentRange, text) => {
    await withPreview(async (url) => {
      const response = await fetch(new URL('/media/0', url), {
        headers: { Range: range },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-range')).toBe(contentRange);
      expect(await response.text()).toBe(text);
    });
  });

  it('sends the whole file without a Range, and no body for HEAD', async () => {
    await withPreview(async (url) => {
      const whole = await fetch(new URL('/media/0', url));
      expect(whole.status).toBe(200);
      expect(whole.headers.get('accept-ranges')).toBe('bytes');
      expect(whole.headers.get('content-length')).toBe('9');
      expect(await whole.text()).toBe('012345678');
      const head = await fetch(new URL('/media/0', url), { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    });
  });

  it.each([
    '/../../../etc/passwd',
    '/..%2f..%2f..%2fetc%2fpasswd',
    '/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
    '/media/99',
    '/assets',
  ])('does not serve %s', async (path) => {
    await withPreview(async (url) => {
      // node:http sends the path as written; fetch would normalise it.
      const { port } = new URL(url);
      const status = await new Promise<number>((resolveStatus, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path, method: 'GET' },
          (response) => {
            response.resume();
            resolveStatus(response.statusCode ?? 0);
          }
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(404);
    });
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
      const rel = (dest: string) => dest.slice(cwd.length + 1);
      expect(dests.map(rel)).toEqual([
        '.agents/skills/stitch',
        '.agents/skills/stitch-player',
        '.claude/skills/stitch',
        '.claude/skills/stitch-player',
      ]);
      const stitch = await readFile(
        join(cwd, '.claude/skills/stitch/SKILL.md'),
        'utf8'
      );
      const player = await readFile(
        join(cwd, '.agents/skills/stitch-player/SKILL.md'),
        'utf8'
      );
      expect(stitch).toContain('name: stitch');
      expect(stitch).toContain('user-invocable: true');
      expect(player).toContain('name: stitch-player');
      expect(player).toContain('@openstory/stitch');
      const home = join(cwd, 'home');
      const globalDests = await installSkill({
        cwd,
        home,
        global: true,
        packageRoot: packageRoot(),
      });
      expect(globalDests.map((dest) => dest.slice(home.length + 1))).toEqual([
        '.agents/skills/stitch',
        '.agents/skills/stitch-player',
        '.claude/skills/stitch',
        '.claude/skills/stitch-player',
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('replaces its own trees and leaves other skills alone', async () => {
    const cwd = await tempDir('stitch-reinstall-');
    try {
      await mkdir(join(cwd, '.claude/skills/stitch'), { recursive: true });
      await mkdir(join(cwd, '.claude/skills/other'), { recursive: true });
      await writeFile(join(cwd, '.claude/skills/stitch/stale.md'), 'old');
      await writeFile(join(cwd, '.claude/skills/other/SKILL.md'), 'mine');
      await installSkill({
        cwd,
        home: join(cwd, 'home'),
        global: false,
        packageRoot: packageRoot(),
      });
      await expect(
        readFile(join(cwd, '.claude/skills/stitch/stale.md'))
      ).rejects.toThrow();
      expect(
        await readFile(join(cwd, '.claude/skills/other/SKILL.md'), 'utf8')
      ).toBe('mine');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('stitch main', () => {
  it('prints the usage for --help', async () => {
    const stdout: string[] = [];
    const before = process.exitCode;
    try {
      process.exitCode = undefined;
      await main(['--help'], {
        stdout: { write: (text) => stdout.push(text) },
      });
      expect(stdout.join('')).toBe(usage);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = before;
    }
  });

  it('writes a parse error to stderr and fails', async () => {
    const stderr: string[] = [];
    const before = process.exitCode;
    try {
      await main(['--nope'], {
        stderr: { write: (text) => stderr.push(text) },
      });
      expect(stderr.join('')).toContain('Unknown argument: --nope');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
  });

  it('says when the preview page is not built', async () => {
    const cwd = await tempDir('stitch-unbuilt-');
    const stderr: string[] = [];
    const before = process.exitCode;
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await main(['board.png', '--no-open'], {
        cwd,
        packageRoot: cwd,
        stderr: { write: (text) => stderr.push(text) },
      });
      expect(stderr.join('')).toContain('The preview page is not built');
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('stitch remote media', () => {
  it('takes a URL still and proxies a remote file with its Range', async () => {
    const cwd = await tempDir('stitch-remote-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'body.mp4'), '012345678');
      await writeFile(join(cwd, 'index.html'), '<p>remote</p>');
      // The "remote": a second preview that serves cwd as static files.
      const remote = await startPreview({
        served: {
          clips: [],
          frameWidth: 1,
          frameHeight: 1,
          musicUrl: null,
          musicGainDb: 0,
          files: new Map(),
        },
        pageDir: cwd,
        port: 0,
      });
      try {
        const boardUrl = new URL('/board.png?sig=1', remote.url).href;
        const bodyUrl = new URL('/body.mp4', remote.url).href;
        const request = await parseArgs([boardUrl, bodyUrl, '--no-open'], cwd);
        if (request.kind !== 'play') throw new Error('expected a cut');
        expect(request.clips[0]).toMatchObject({
          kind: 'still',
          file: boardUrl,
          width: 1,
        });
        expect(request.clips[1]).toMatchObject({
          kind: 'video',
          file: bodyUrl,
        });
        const served = await serveCut(request);
        expect(served.files.get('1')).toBe(bodyUrl);
        const preview = await startPreview({ served, pageDir: cwd, port: 0 });
        try {
          const part = await fetch(new URL('/media/1', preview.url), {
            headers: { Range: 'bytes=2-4' },
          });
          expect(part.status).toBe(206);
          expect(part.headers.get('content-range')).toBe('bytes 2-4/9');
          expect(part.headers.get('content-type')).toBe('video/mp4');
          expect(await part.text()).toBe('234');
          const whole = await fetch(new URL('/media/1', preview.url));
          expect(whole.status).toBe(200);
          expect(whole.headers.get('content-length')).toBe('9');
          expect(await whole.text()).toBe('012345678');
        } finally {
          await preview.close();
        }
        await expect(
          parseArgs([new URL('/missing.png', remote.url).href], cwd)
        ).rejects.toThrow(/HTTP 404/);
      } finally {
        await remote.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('stitch frame', () => {
  async function cutOf(argv: string[]) {
    const cwd = await tempDir('stitch-frame-');
    try {
      await writeFile(join(cwd, 'board.png'), png);
      await writeFile(join(cwd, 'shot.mp4'), 'video');
      await writeFile(join(cwd, 'other.mp4'), 'video');
      await writeFile(
        join(cwd, 'lines.srt'),
        '1\n00:00:01,000 --> 00:00:02,000\nHi\n'
      );
      readVideoDisplaySize.mockClear();
      const request = await parseArgs(argv, cwd);
      if (request.kind !== 'play') throw new Error('expected a cut');
      return await serveCut(request);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  it('takes a ratio or a size and reads no video', async () => {
    const ratio = await cutOf(['--frame', '9:16', 'shot.mp4', 'other.mp4']);
    expect([ratio.frameWidth, ratio.frameHeight]).toEqual([9, 16]);
    const size = await cutOf(['--frame', '1080X1920', 'shot.mp4']);
    expect([size.frameWidth, size.frameHeight]).toEqual([1080, 1920]);
    expect(readVideoDisplaySize).not.toHaveBeenCalled();
  });

  it('reads only the first video for the box', async () => {
    const served = await cutOf(['shot.mp4', 'other.mp4', 'board.png']);
    expect([served.frameWidth, served.frameHeight]).toEqual([480, 854]);
    expect(readVideoDisplaySize).toHaveBeenCalledTimes(1);
  });

  it('reads every video only when --subs needs the lengths', async () => {
    const served = await cutOf([
      '--frame',
      '1:1',
      '--subs',
      'lines.srt',
      'shot.mp4',
      'other.mp4',
    ]);
    expect(readVideoDisplaySize).toHaveBeenCalledTimes(2);
    expect(served.clips[0]?.cues).toEqual([
      { startSeconds: 1, endSeconds: 2, text: 'Hi' },
    ]);
  });
});
