import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { downloadSequenceAssets } from './assets.js';
import { main, parseArgs } from './cli.js';

const origin = 'https://os.test';

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function manifest(assets: unknown[]) {
  return {
    sequenceId: 'SEQ',
    title: 'Room',
    scope: 'selected',
    includeExports: false,
    assets,
  };
}

describe('stitch pull', () => {
  it('parses flags before the global help short-circuit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-assets-'));
    try {
      expect(await parseArgs(['pull', '--help'], cwd)).toEqual({
        kind: 'help',
      });
      expect(
        await parseArgs(
          [
            'pull',
            'SEQ',
            '--history',
            '--exports',
            '--origin',
            'http://localhost:3000/ignored',
            '--dir',
            'out',
          ],
          cwd
        )
      ).toEqual({
        kind: 'pull',
        sequenceId: 'SEQ',
        origin: 'http://localhost:3000',
        dir: join(cwd, 'out'),
        history: true,
        exports: true,
      });
      await expect(parseArgs(['pull'], cwd)).rejects.toThrow('sequence id');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes files, links a shared file, skips a second run, and refuses ..', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-assets-'));
    try {
      const home = join(cwd, 'home');
      const dest = join(cwd, 'out');
      const calls: string[] = [];
      let token = 'old';
      const fetchFn: typeof fetch = async (input, init) => {
        const url = new URL(requestUrl(input));
        calls.push(url.pathname);
        const auth = new Headers(init?.headers).get('authorization');
        if (auth === 'Bearer old') return new Response('no', { status: 401 });
        if (auth !== 'Bearer new') return new Response('no', { status: 401 });
        if (url.pathname === '/api/v1/sequences/SEQ/assets') {
          return Response.json(
            manifest([
              {
                relativePath: 'script.txt',
                versionId: 'script-1',
                url: null,
                text: 'INT. ROOM',
                shared: false,
              },
              {
                relativePath: 'cast/c/looks/c/sheet.png',
                versionId: 'sheet:1',
                url: '/r2/team/sheet.png?download',
                text: null,
                shared: true,
              },
            ])
          );
        }
        if (url.pathname === '/r2/team/sheet.png') {
          return new Response('png-bytes');
        }
        return new Response('missing', { status: 404 });
      };
      const first = await downloadSequenceAssets({
        sequenceId: 'SEQ',
        origin,
        home,
        dest,
        history: false,
        includeExports: false,
        fetch: fetchFn,
        key: async () => token,
        refresh: async () => {
          token = 'new';
          return token;
        },
      });
      expect(first).toEqual({ saved: 2, skipped: 0 });
      expect(await readFile(join(dest, 'script.txt'), 'utf8')).toBe(
        'INT. ROOM'
      );
      expect(
        await readFile(join(dest, 'cast/c/looks/c/sheet.png'), 'utf8')
      ).toBe('png-bytes');
      const cache = join(
        home,
        '.openstory',
        'assets',
        `${createHash('sha256').update('/r2/team/sheet.png').digest('hex')}.png`
      );
      const cached = await stat(cache);
      const linked = await stat(join(dest, 'cast/c/looks/c/sheet.png'));
      expect(linked.ino).toBe(cached.ino);
      const downloads = calls.filter((path) => path.startsWith('/r2/'));
      expect(downloads).toEqual(['/r2/team/sheet.png']);

      calls.length = 0;
      const second = await downloadSequenceAssets({
        sequenceId: 'SEQ',
        origin,
        home,
        dest,
        history: false,
        includeExports: false,
        fetch: fetchFn,
        key: async () => 'new',
        refresh: async () => 'newer',
      });
      expect(second).toEqual({ saved: 0, skipped: 2 });
      expect(calls.filter((path) => path.startsWith('/r2/'))).toEqual([]);

      await expect(
        downloadSequenceAssets({
          sequenceId: 'SEQ',
          origin,
          home,
          dest,
          history: false,
          includeExports: false,
          fetch: async () =>
            Response.json(
              manifest([
                {
                  relativePath: '../secret.txt',
                  versionId: 'x',
                  url: null,
                  text: 'no',
                  shared: false,
                },
              ])
            ),
          key: async () => 'new',
          refresh: async () => 'new',
        })
      ).rejects.toThrow('Refusing to write ../secret.txt');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('runs without the preview page', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-assets-'));
    try {
      const home = join(cwd, 'home');
      await mkdir(join(home, '.openstory'), { recursive: true });
      await writeFile(
        join(home, '.openstory', 'stitch.json'),
        JSON.stringify({ keys: { 'https://openstory.so': 'osk_1' } })
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      await main(['pull', 'SEQ', '--dir', 'out'], {
        cwd,
        home,
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
        packageRoot: join(cwd, 'missing-package'),
        fetch: async (input) => {
          const url = new URL(requestUrl(input));
          if (url.pathname === '/api/v1/sequences/SEQ/assets') {
            expect(url.searchParams.get('scope')).toBe('selected');
            return Response.json(manifest([]));
          }
          return new Response('missing', { status: 404 });
        },
      });
      expect(stdout.join('')).toBe('Saved 0 files. Skipped 0 already there.\n');
      expect(stderr).toEqual([]);
      await main(['pull', 'SEQ', '--history', '--exports', '--dir', 'out'], {
        cwd,
        home,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        packageRoot: join(cwd, 'missing-package'),
        fetch: async (input) => {
          const url = new URL(requestUrl(input));
          expect(url.searchParams.get('scope')).toBe('history');
          expect(url.searchParams.get('exports')).toBe('true');
          return Response.json(manifest([]));
        },
      });
      expect(
        await readFile(join(cwd, 'out', 'manifest.json'), 'utf8')
      ).toContain('"assets": []');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps a portrait out of the sheet cache and refuses a path that leaves the folder', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'stitch-assets-'));
    try {
      const home = join(cwd, 'home');
      const dest = join(cwd, 'out');
      const fetched: string[] = [];
      const fetchFn: typeof fetch = async (input) => {
        const url = new URL(requestUrl(input));
        fetched.push(url.href);
        if (url.pathname === '/api/v1/sequences/SEQ/assets') {
          return Response.json(
            manifest([
              {
                relativePath: 'cast/c/portrait.png',
                versionId: 'sheet-1',
                url: '/r2/team/portrait.png?download',
                text: null,
                shared: true,
              },
              {
                relativePath: 'cast/c/sheet.png',
                versionId: 'sheet-1',
                url: '/r2/team/sheet.png?download',
                text: null,
                shared: true,
              },
            ])
          );
        }
        if (url.pathname === '/r2/team/portrait.png') {
          return new Response('portrait-bytes');
        }
        if (url.pathname === '/r2/team/sheet.png') {
          return new Response('sheet-bytes');
        }
        return new Response('missing', { status: 404 });
      };
      await downloadSequenceAssets({
        sequenceId: 'SEQ',
        origin,
        home,
        dest,
        history: false,
        includeExports: false,
        fetch: fetchFn,
        key: async () => 'new',
        refresh: async () => 'new',
      });
      expect(await readFile(join(dest, 'cast/c/portrait.png'), 'utf8')).toBe(
        'portrait-bytes'
      );
      expect(await readFile(join(dest, 'cast/c/sheet.png'), 'utf8')).toBe(
        'sheet-bytes'
      );

      await expect(
        downloadSequenceAssets({
          sequenceId: 'SEQ',
          origin,
          home,
          dest,
          history: false,
          includeExports: false,
          fetch: async () =>
            Response.json(
              manifest([
                {
                  relativePath: '/etc/passwd',
                  versionId: 'x',
                  url: null,
                  text: 'no',
                  shared: false,
                },
              ])
            ),
          key: async () => 'new',
          refresh: async () => 'new',
        })
      ).rejects.toThrow('Refusing to write /etc/passwd');

      await expect(
        downloadSequenceAssets({
          sequenceId: 'SEQ',
          origin,
          home,
          dest,
          history: false,
          includeExports: false,
          fetch: async () =>
            Response.json(
              manifest([
                {
                  relativePath: 'cast/c/sheet.png',
                  versionId: 'x',
                  url: 'https://evil.example/sheet.png',
                  text: null,
                  shared: false,
                },
              ])
            ),
          key: async () => 'new',
          refresh: async () => 'new',
        })
      ).rejects.toThrow('Refusing https://evil.example/sheet.png');
      expect(fetched.some((url) => url.includes('evil.example'))).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
