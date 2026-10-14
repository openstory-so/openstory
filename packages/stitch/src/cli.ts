/**
 * `stitch` plays local stills and videos in the browser, and `stitch skill`
 * copies the /stitch command and the stitch-player contract into .agents/skills.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readImageSize } from './image-size.js';
import type { PlaybackClip, PlaybackCue } from './playback-clip.js';
import { placeTimelineCues } from './place-cues.js';
import { canvasResolution } from './resolution.js';
import type { ClipDimensions } from './resolution.js';
import { parseSubtitles } from './subtitles.js';
import type { TimelineCue } from './subtitles.js';
import { readAudioDuration, readVideoDisplaySize } from './video-size.js';

const STILL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const DEFAULT_STILL_SECONDS = 4;

export const usage = `Usage: stitch [--music file] [--music-gain db] [--subs file] [--port n] [--no-open]
             <file> [--poster file] [--fallback file] [--audio file] [--seconds n] [--cue start-end text]...

       stitch skill [--global]

Play local stills and videos in the browser. A .mp4, .webm, or .mov is a
video, and it plays the sound inside the file. A .png, .jpg, .jpeg, or .webp is a
still. --poster belongs to the video before it. --fallback, --audio, and
--seconds belong to the still before them. --cue belongs to the clip before
it. --subs is one .srt or .vtt for the whole cut. --seconds defaults to ${DEFAULT_STILL_SECONDS}.

stitch skill copies stitch and stitch-player into .agents/skills/.
Agents load stitch as the /stitch command. stitch-player is the contract
for embedding the player. --global copies both to ~/.agents/skills/.
`;

type Still = {
  kind: 'still';
  file: string;
  seconds: number;
  audio: string[];
  fallback: string | null;
  width: number;
  height: number;
  cues: PlaybackCue[];
};

type Video = {
  kind: 'video';
  file: string;
  poster: string | null;
  cues: PlaybackCue[];
};

type LocalClip = Still | Video;

export type LocalCut = {
  clips: LocalClip[];
  music: string | null;
  musicGainDb: number;
  /** Whole-cut subtitles. Null when --subs was omitted. */
  subs: TimelineCue[] | null;
  open: boolean;
  port: number;
};

export type ServedCut = {
  clips: PlaybackClip[];
  /** Canvas box. Videos own it; a still-only cut uses the stills. */
  frameWidth: number;
  frameHeight: number;
  musicUrl: string | null;
  musicGainDb: number;
  files: ReadonlyMap<string, string>;
};

type SkillRequest = { kind: 'skill'; global: boolean };
type HelpRequest = { kind: 'help' };
type PlayRequest = { kind: 'play' } & LocalCut;
export type CliRequest = SkillRequest | HelpRequest | PlayRequest;

export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export async function parseArgs(
  argv: string[],
  cwd: string
): Promise<CliRequest> {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  if (argv[0] === 'skill') return parseSkill(argv.slice(1));
  return { kind: 'play', ...(await parseCut(argv, cwd)) };
}

function parseSkill(argv: string[]): SkillRequest {
  let global = false;
  for (const arg of argv) {
    if (arg === '--global' || arg === '-g') global = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { kind: 'skill', global };
}

async function parseCut(argv: string[], cwd: string): Promise<LocalCut> {
  const clips: LocalClip[] = [];
  let music: string | null = null;
  let musicGainDb = 0;
  let subs: TimelineCue[] | null = null;
  let open = true;
  let port = 0;

  const take = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('-'))
      throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--no-open') {
      open = false;
      continue;
    }
    if (arg === '--music') {
      music = await existingFile(take(arg, i), cwd);
      i += 1;
      continue;
    }
    if (arg === '--music-gain') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      musicGainDb = numberValue(value, arg);
      i += 1;
      continue;
    }
    if (arg === '--port') {
      port = portValue(take(arg, i));
      i += 1;
      continue;
    }
    if (arg === '--subs') {
      if (subs) throw new Error('--subs is already set');
      const file = await existingFile(take(arg, i), cwd);
      const extension = extname(file).toLowerCase();
      if (!new Set(['.srt', '.vtt', '.webvtt']).has(extension)) {
        throw new Error('--subs needs an .srt or .vtt file');
      }
      subs = parseSubtitles(await readFile(file, 'utf8'), file);
      i += 1;
      continue;
    }
    if (arg === '--poster') {
      const clip = previousClip(clips, arg);
      if (clip.kind !== 'video') {
        throw new Error('--poster belongs on a video');
      }
      if (clip.poster) throw new Error('--poster is already set');
      clip.poster = await existingFile(take(arg, i), cwd);
      i += 1;
      continue;
    }
    if (arg === '--fallback') {
      const clip = previousStill(clips, arg);
      if (clip.fallback) throw new Error('--fallback is already set');
      clip.fallback = await existingFile(take(arg, i), cwd);
      i += 1;
      continue;
    }
    if (arg === '--audio' || arg === '--seconds') {
      const clip = previousStill(clips, arg);
      if (arg === '--audio')
        clip.audio.push(await existingFile(take(arg, i), cwd));
      else clip.seconds = positive(take(arg, i), arg);
      i += 1;
      continue;
    }
    if (arg === '--cue') {
      const clip = previousClip(clips, arg);
      const range = take(arg, i);
      const text = argv[i + 2];
      if (text === undefined || text.startsWith('-'))
        throw new Error('--cue needs a range and text');
      clip.cues.push(cue(range, text));
      i += 2;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    clips.push(await clipFromFile(arg, cwd));
  }

  if (clips.length === 0) throw new Error('Name at least one still or video');
  return { clips, music, musicGainDb, subs, open, port };
}

function previousClip(clips: LocalClip[], flag: string): LocalClip {
  const clip = clips.at(-1);
  if (!clip) throw new Error(`${flag} comes after the clip it belongs to`);
  return clip;
}

function previousStill(clips: LocalClip[], flag: string): Still {
  const clip = previousClip(clips, flag);
  if (clip.kind === 'video') {
    throw new Error(
      `${flag} belongs on a still. A video plays the sound inside the file`
    );
  }
  return clip;
}

async function clipFromFile(arg: string, cwd: string): Promise<LocalClip> {
  const file = await existingFile(arg, cwd);
  const extension = extname(file).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { kind: 'video', file, poster: null, cues: [] };
  }
  if (STILL_EXTENSIONS.has(extension)) {
    const bytes = await readFile(file);
    let size: { width: number; height: number };
    try {
      size = readImageSize(bytes);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'unreadable image';
      throw new Error(`${arg}: ${message}`);
    }
    if (!(size.width > 0 && size.height > 0)) {
      throw new Error(`${arg}: a still needs a positive width and height`);
    }
    return {
      kind: 'still',
      file,
      seconds: DEFAULT_STILL_SECONDS,
      audio: [],
      fallback: null,
      width: size.width,
      height: size.height,
      cues: [],
    };
  }
  throw new Error(
    `${arg} is not a still or a video. Stills are png, jpg, jpeg, and webp. Videos are mp4, webm, and mov`
  );
}

async function existingFile(arg: string, cwd: string): Promise<string> {
  const file = resolve(cwd, arg);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    throw new Error(`Cannot read ${arg}`);
  }
  if (!info.isFile()) throw new Error(`${arg} is not a file`);
  return file;
}

function numberValue(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    throw new Error(`${flag} needs a number, got ${value}`);
  return parsed;
}

function positive(value: string, flag: string): number {
  const parsed = numberValue(value, flag);
  if (!(parsed > 0))
    throw new Error(`${flag} needs a positive number, got ${value}`);
  return parsed;
}

function portValue(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error(`--port needs a port number, got ${value}`);
  const port = Number(value);
  if (port > 65535) throw new Error(`--port needs a port number, got ${value}`);
  return port;
}

async function stillDuration(clip: Still): Promise<number> {
  let audio = 0;
  for (const file of clip.audio) audio += await readAudioDuration(file);
  return Math.max(clip.seconds, audio);
}

function cue(range: string, text: string): PlaybackCue {
  const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(range);
  if (!match) throw new Error(`--cue range looks like 0-2, got ${range}`);
  const startSeconds = Number(match[1]);
  const endSeconds = Number(match[2]);
  if (!(startSeconds >= 0 && startSeconds < endSeconds)) {
    throw new Error(`--cue needs 0 <= start < end, got ${range}`);
  }
  if (text.trim() === '') throw new Error('--cue needs text');
  return { startSeconds, endSeconds, text };
}

export async function serveCut(cut: LocalCut): Promise<ServedCut> {
  const files = new Map<string, string>();
  const urls = new Map<string, string>();
  const urlFor = async (file: string): Promise<string> => {
    const key = await realpath(file);
    const existing = urls.get(key);
    if (existing) return existing;
    const id = String(files.size);
    files.set(id, key);
    const url = `/media/${id}`;
    urls.set(key, url);
    return url;
  };

  const clips: PlaybackClip[] = [];
  const videoDimensions: ClipDimensions[] = [];
  const clipDimensions: ClipDimensions[] = [];
  const durations: number[] = [];
  for (const clip of cut.clips) {
    if (clip.kind === 'video') {
      const size = await readVideoDisplaySize(clip.file);
      videoDimensions.push(size);
      clipDimensions.push(size);
      if (cut.subs) durations.push(size.durationSeconds);
      clips.push({
        videoUrl: await urlFor(clip.file),
        posterUrl: clip.poster ? await urlFor(clip.poster) : null,
        cues: clip.cues,
      });
    } else {
      clipDimensions.push({ width: clip.width, height: clip.height });
      if (cut.subs) durations.push(await stillDuration(clip));
      clips.push({
        imageUrl: await urlFor(clip.file),
        fallbackImageUrl: clip.fallback ? await urlFor(clip.fallback) : null,
        durationSeconds: clip.seconds,
        audioUrls: await Promise.all(clip.audio.map((file) => urlFor(file))),
        width: clip.width,
        height: clip.height,
        cues: clip.cues,
      });
    }
  }
  if (cut.subs) {
    const placed = placeTimelineCues(durations, cut.subs);
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const extra = placed[i] ?? [];
      if (clip) clips[i] = { ...clip, cues: [...clip.cues, ...extra] };
    }
  }
  const frame = canvasResolution(videoDimensions, clipDimensions);
  return {
    clips,
    frameWidth: frame.width,
    frameHeight: frame.height,
    musicUrl: cut.music ? await urlFor(cut.music) : null,
    musicGainDb: cut.musicGainDb,
    files,
  };
}

const SKILL_NAMES = ['stitch', 'stitch-player'] as const;

export async function installSkill(options: {
  cwd: string;
  home: string;
  global: boolean;
  packageRoot: string;
}): Promise<string[]> {
  const destRoot = options.global
    ? join(options.home, '.agents', 'skills')
    : join(options.cwd, '.agents', 'skills');
  await mkdir(destRoot, { recursive: true });
  const dests: string[] = [];
  for (const name of SKILL_NAMES) {
    const dest = join(destRoot, name);
    await rm(dest, { recursive: true, force: true });
    await cp(join(options.packageRoot, 'skills', name), dest, {
      recursive: true,
    });
    dests.push(dest);
  }
  return dests;
}

export async function startPreview(options: {
  served: ServedCut;
  pageDir: string;
  port: number;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const pageDir = resolve(options.pageDir);
  const server = createServer((request, response) => {
    void handleRequest(request, response, options.served, pageDir).catch(
      (error: unknown) => {
        const message =
          error instanceof Error ? error.message : 'preview failed';
        if (!response.headersSent) {
          response.writeHead(500, {
            'Content-Type': 'text/plain; charset=utf-8',
          });
        }
        response.end(message);
      }
    );
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The preview server has no port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  served: ServedCut,
  pageDir: string
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/cut.json') {
    const body = JSON.stringify({
      clips: served.clips,
      frameWidth: served.frameWidth,
      frameHeight: served.frameHeight,
      musicUrl: served.musicUrl,
      musicGainDb: served.musicGainDb,
    });
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }
  const media = /^\/media\/(\d+)$/.exec(url.pathname);
  if (media) {
    const file = served.files.get(media[1] ?? '');
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('No such media');
      return;
    }
    await sendFile(request, response, file, mediaType(file));
    return;
  }
  const relative =
    url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const full = resolve(pageDir, relative);
  if (full !== pageDir && !full.startsWith(pageDir + sep)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Outside the preview');
    return;
  }
  try {
    await stat(full);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  await sendFile(request, response, full, mediaType(full));
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  contentType: string
): Promise<void> {
  const info = await stat(file);
  const size = info.size;
  const range = request.headers.range;
  const common = { 'Accept-Ranges': 'bytes', 'Content-Type': contentType };
  if (range === undefined) {
    response.writeHead(200, { ...common, 'Content-Length': size });
    if (request.method === 'HEAD') response.end();
    else pipeFile(file, response);
    return;
  }
  const parsed = byteRange(range, size);
  if (parsed === null) {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...common,
    'Content-Length': parsed.end - parsed.start + 1,
    'Content-Range': `bytes ${parsed.start}-${parsed.end}/${size}`,
  });
  if (request.method === 'HEAD') response.end();
  else pipeFile(file, response, parsed);
}

function pipeFile(
  file: string,
  response: ServerResponse,
  range?: { start: number; end: number }
): void {
  const stream = createReadStream(file, range);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
}

function byteRange(
  header: string,
  size: number
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || size === 0) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (startText === '' && endText === '') return null;
  if (startText === '') {
    const length = Number(endText);
    if (!(length > 0)) return null;
    const start = Math.max(0, size - length);
    return { start, end: size - 1 };
  }
  const start = Number(startText);
  const end = endText === '' ? size - 1 : Number(endText);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function mediaType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    case '.mov':
      return 'video/quicktime';
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.m4a':
      return 'audio/mp4';
    case '.ogg':
      return 'audio/ogg';
    case '.svg':
      return 'image/svg+xml';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

export function openUrl(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

export async function main(
  argv: string[],
  io: {
    cwd?: string;
    stdout?: { write: (text: string) => void };
    stderr?: { write: (text: string) => void };
    home?: string;
    open?: (url: string) => void;
    packageRoot?: string;
  } = {}
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  try {
    const request = await parseArgs(argv, cwd);
    if (request.kind === 'help') {
      stdout.write(usage);
      return;
    }
    if (request.kind === 'skill') {
      const dests = await installSkill({
        cwd,
        home: io.home ?? homedir(),
        global: request.global,
        packageRoot: io.packageRoot ?? packageRoot(),
      });
      stdout.write(dests.map((dest) => `${dest}\n`).join(''));
      return;
    }
    const served = await serveCut(request);
    const pageDir = join(io.packageRoot ?? packageRoot(), 'dist', 'page');
    try {
      await stat(join(pageDir, 'index.html'));
    } catch {
      throw new Error(
        'The preview page is not built. Run bun run --cwd packages/stitch build'
      );
    }
    const preview = await startPreview({ served, pageDir, port: request.port });
    stdout.write(`${preview.url}\n`);
    if (request.open) (io.open ?? openUrl)(preview.url);
    await new Promise<void>((resolveStop) => {
      const stop = () => {
        void preview.close().then(resolveStop);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } catch (error) {
    stderr.write(
      `${error instanceof Error ? error.message : 'stitch failed'}\n`
    );
    process.exitCode = 1;
  }
}
