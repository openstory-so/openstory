/**
 * `stitch` plays local and remote stills and videos in the browser, and `stitch skill`
 * copies the /stitch command and the stitch-player contract into
 * .agents/skills and .claude/skills.
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
import { pipeline, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { readImageSize } from './image-size.js';
import type { PlaybackClip, PlaybackCue } from './playback-clip.js';
import { placeTimelineCues } from './place-cues.js';
import { parseSubtitles } from './subtitles.js';
import type { TimelineCue } from './subtitles.js';
import {
  isHttpUrl,
  readAudioDuration,
  readVideoDisplaySize,
} from './video-size.js';

const STILL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const DEFAULT_STILL_SECONDS = 4;

export const usage = `Usage: stitch [--frame 16:9|WxH] [--music file] [--music-gain db] [--subs file] [--port n] [--no-open]
             <file> [--poster file] [--fallback file] [--audio file] [--seconds n] [--cue start-end text]...

       stitch skill [--global]

Play stills and videos in the browser. Each file is a path or an http(s) URL;
the page reads a URL through this server. A .mp4, .webm, or .mov is a
video, and it plays the sound inside the file. A .png, .jpg, .jpeg, or .webp is a
still. --poster belongs to an opening video and shows while the cut opens.
--fallback, --audio, and --seconds belong to the still before them. --cue belongs to the clip before
it. --subs is one .srt or .vtt for the whole cut. --seconds defaults to ${DEFAULT_STILL_SECONDS}.
--frame is the shape of the page, as a ratio (9:16) or a size (1080x1920).
Without it the first clip sets the shape. Every clip is fitted into that box.

stitch skill copies stitch and stitch-player into .agents/skills/ and
.claude/skills/. Agents load stitch as the /stitch command. stitch-player
is the contract for embedding the player. --global copies both trees into
the home directory.
`;

type Still = {
  kind: 'still';
  file: string;
  seconds: number;
  audio: string[];
  /** Summed length of the --audio files, read when each was named. */
  audioSeconds: number;
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
  /** --frame. Null means the first clip sets the box. */
  frame: { width: number; height: number } | null;
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
  let frame: { width: number; height: number } | null = null;
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
      if (music) throw new Error('--music is already set');
      music = await existingFile(take(arg, i), cwd);
      await readAudioDuration(music);
      i += 1;
      continue;
    }
    if (arg === '--frame') {
      if (frame) throw new Error('--frame is already set');
      frame = frameValue(take(arg, i));
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
      const extension = extensionOf(file);
      if (!new Set(['.srt', '.vtt', '.webvtt']).has(extension)) {
        throw new Error('--subs needs an .srt or .vtt file');
      }
      subs = parseSubtitles((await readBytes(file)).toString('utf8'), file);
      i += 1;
      continue;
    }
    if (arg === '--poster') {
      const clip = previousClip(clips, arg);
      if (clip.kind !== 'video') {
        throw new Error('--poster belongs on a video');
      }
      if (clips.length > 1) {
        throw new Error(
          '--poster belongs on the first clip. The page shows it while the cut opens'
        );
      }
      if (clip.poster) throw new Error('--poster is already set');
      clip.poster = await imageFile(take(arg, i), cwd);
      i += 1;
      continue;
    }
    if (arg === '--fallback') {
      const clip = previousStill(clips, arg);
      if (clip.fallback) throw new Error('--fallback is already set');
      clip.fallback = await imageFile(take(arg, i), cwd);
      i += 1;
      continue;
    }
    if (arg === '--audio' || arg === '--seconds') {
      const clip = previousStill(clips, arg);
      if (arg === '--audio') {
        const file = await existingFile(take(arg, i), cwd);
        clip.audioSeconds += await readAudioDuration(file);
        clip.audio.push(file);
      } else clip.seconds = positive(take(arg, i), arg);
      i += 1;
      continue;
    }
    if (arg === '--cue') {
      const clip = previousClip(clips, arg);
      const range = take(arg, i);
      const text = argv[i + 2];
      if (text === undefined) throw new Error('--cue needs a range and text');
      clip.cues.push(cue(range, text));
      i += 2;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    clips.push(await clipFromFile(arg, cwd));
  }

  if (clips.length === 0) throw new Error('Name at least one still or video');
  return { clips, frame, music, musicGainDb, subs, open, port };
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
  const extension = extensionOf(file);
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { kind: 'video', file, poster: null, cues: [] };
  }
  if (STILL_EXTENSIONS.has(extension)) {
    const size = await stillSize(file, arg);
    return {
      kind: 'still',
      file,
      seconds: DEFAULT_STILL_SECONDS,
      audio: [],
      audioSeconds: 0,
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

async function stillSize(
  file: string,
  arg: string
): Promise<{ width: number; height: number }> {
  let size: { width: number; height: number };
  try {
    size = readImageSize(await readBytes(file));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unreadable image';
    throw new Error(`${arg}: ${message}`);
  }
  if (!(size.width > 0 && size.height > 0)) {
    throw new Error(`${arg}: a still needs a positive width and height`);
  }
  return size;
}

/** A poster or fallback: a png, jpeg, or webp the browser can draw. */
async function imageFile(arg: string, cwd: string): Promise<string> {
  const file = await existingFile(arg, cwd);
  if (!STILL_EXTENSIONS.has(extensionOf(file))) {
    throw new Error(`${arg} is not a png, jpg, jpeg, or webp`);
  }
  await stillSize(file, arg);
  return file;
}

/** The bytes of a path or an http(s) URL. Stills and --subs are read whole. */
async function readBytes(file: string): Promise<Buffer> {
  if (!isHttpUrl(file)) return readFile(file);
  const response = await fetch(file);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The extension of a path, or of a URL's path. */
function extensionOf(file: string): string {
  const path = isHttpUrl(file) ? new URL(file).pathname : file;
  return extname(path).toLowerCase();
}

async function existingFile(arg: string, cwd: string): Promise<string> {
  if (isHttpUrl(arg)) return arg;
  const file = resolve(cwd, arg);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') throw new Error(`${arg} does not exist`);
    if (code === 'EACCES') throw new Error(`${arg}: permission denied`);
    const message = error instanceof Error ? error.message : 'unreadable';
    throw new Error(`Cannot read ${arg}: ${message}`);
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

/** 16:9 or 1080x1920. Only the ratio matters: the page is a box of this shape. */
function frameValue(value: string): { width: number; height: number } {
  const match = /^(\d+)[x:](\d+)$/i.exec(value);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!(width > 0 && height > 0)) {
    throw new Error(
      `--frame needs a ratio like 9:16 or a size like 1080x1920, got ${value}`
    );
  }
  return { width, height };
}

function portValue(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error(`--port needs a port number, got ${value}`);
  const port = Number(value);
  if (port > 65535) throw new Error(`--port needs a port number, got ${value}`);
  return port;
}

function stillDuration(clip: Still): number {
  return Math.max(clip.seconds, clip.audioSeconds);
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
    const key = isHttpUrl(file) ? file : await realpath(file);
    const existing = urls.get(key);
    if (existing) return existing;
    const id = String(files.size);
    files.set(id, key);
    const url = `/media/${id}`;
    urls.set(key, url);
    return url;
  };

  // Only --subs needs every clip's length, and only a first video sets the
  // box; nothing else is read before the page opens. A remote clip that will
  // not open fails in the player, with its message.
  const clips: PlaybackClip[] = [];
  const durations: number[] = [];
  let frame = cut.frame;
  for (const [i, clip] of cut.clips.entries()) {
    if (clip.kind === 'video') {
      const probe =
        (i === 0 && !frame) || cut.subs
          ? await readVideoDisplaySize(clip.file)
          : null;
      if (i === 0 && !frame && probe) frame = probe;
      durations.push(probe?.durationSeconds ?? 0);
      clips.push({
        videoUrl: await urlFor(clip.file),
        posterUrl: clip.poster ? await urlFor(clip.poster) : null,
        cues: clip.cues,
      });
    } else {
      if (i === 0 && !frame) frame = { width: clip.width, height: clip.height };
      durations.push(stillDuration(clip));
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
  if (!frame) throw new Error('Name at least one still or video');
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
const SKILL_ROOTS = ['.agents/skills', '.claude/skills'] as const;

export async function installSkill(options: {
  cwd: string;
  home: string;
  global: boolean;
  packageRoot: string;
}): Promise<string[]> {
  const base = options.global ? options.home : options.cwd;
  const dests: string[] = [];
  for (const root of SKILL_ROOTS) {
    const destRoot = join(base, root);
    await mkdir(destRoot, { recursive: true });
    for (const name of SKILL_NAMES) {
      const dest = join(destRoot, name);
      await rm(dest, { recursive: true, force: true });
      await cp(join(options.packageRoot, 'skills', name), dest, {
        recursive: true,
      });
      dests.push(dest);
    }
  }
  return dests;
}

type Writer = { write: (text: string) => void };

export async function startPreview(options: {
  served: ServedCut;
  pageDir: string;
  port: number;
  stderr?: Writer;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const pageDir = resolve(options.pageDir);
  const stderr = options.stderr ?? process.stderr;
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      options.served,
      pageDir,
      stderr
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'preview failed';
      stderr.write(`${request.url ?? '/'}: ${message}\n`);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
      response.end(message);
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', (error) =>
        stderr.write(`Preview server: ${error.message}\n`)
      );
      resolveListen();
    });
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
  pageDir: string,
  stderr: Writer
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
    if (isHttpUrl(file)) await proxyUrl(request, response, file, stderr);
    else await sendFile(request, response, file, mediaType(file), stderr);
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
  const isFile = await stat(full).then(
    (info) => info.isFile(),
    () => false
  );
  if (!isFile) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  await sendFile(request, response, full, mediaType(full), stderr);
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  contentType: string,
  stderr: Writer
): Promise<void> {
  const info = await stat(file);
  const size = info.size;
  const range = request.headers.range;
  const common = { 'Accept-Ranges': 'bytes', 'Content-Type': contentType };
  if (range === undefined) {
    response.writeHead(200, { ...common, 'Content-Length': size });
    if (request.method === 'HEAD') response.end();
    else pipeFile(file, response, stderr);
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
  else pipeFile(file, response, stderr, parsed);
}

/**
 * A remote file, fetched with the browser's Range and streamed back on this
 * origin, so export and picture-in-picture work without CORS on the remote.
 */
async function proxyUrl(
  request: IncomingMessage,
  response: ServerResponse,
  url: string,
  stderr: Writer
): Promise<void> {
  const headers: Record<string, string> = {};
  if (request.headers.range !== undefined)
    headers.Range = request.headers.range;
  const upstream = await fetch(url, { method: request.method, headers });
  // Our own type from the extension, never the remote's: a remote answering
  // text/html must not become a page on this origin.
  const forwarded: Record<string, string> = {
    'Content-Type': mediaType(url),
    'X-Content-Type-Options': 'nosniff',
  };
  for (const name of ['Accept-Ranges', 'Content-Length', 'Content-Range']) {
    const value = upstream.headers.get(name);
    if (value !== null) forwarded[name] = value;
  }
  response.writeHead(upstream.status, forwarded);
  if (request.method === 'HEAD' || upstream.body === null) {
    response.end();
    return;
  }
  pipeline(Readable.from(upstream.body), response, (error) => {
    if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      stderr.write(`${url}: ${error.message}\n`);
    }
  });
}

/** pipeline closes the file when the browser cancels a read (every seek). */
function pipeFile(
  file: string,
  response: ServerResponse,
  stderr: Writer,
  range?: { start: number; end: number }
): void {
  pipeline(createReadStream(file, range), response, (error) => {
    if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      stderr.write(`${file}: ${error.message}\n`);
    }
  });
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
  switch (extensionOf(file)) {
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

export function openUrl(url: string, stderr: Writer = process.stderr): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  const failed = (reason: string) =>
    stderr.write(`Could not open a browser (${reason}). Open ${url}\n`);
  child.on('error', (error) => failed(error.message));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) failed(`${command} exited ${code}`);
  });
  child.unref();
}

export async function main(
  argv: string[],
  io: {
    cwd?: string;
    stdout?: Writer;
    stderr?: Writer;
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
    const preview = await startPreview({
      served,
      pageDir,
      port: request.port,
      stderr,
    });
    stdout.write(`${preview.url}\n`);
    if (request.open) (io.open ?? ((url) => openUrl(url, stderr)))(preview.url);
    await new Promise<void>((resolveStop, rejectStop) => {
      const stop = () => {
        preview.close().then(resolveStop, rejectStop);
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
