/** The bytes, extension, and type of a media path or http(s) URL. */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { isHttpUrl } from './video-size.js';

/**
 * The bytes of a path or an http(s) URL, read whole into memory: stills and
 * --subs while parsing, and every file when bundling a URL or sharing.
 */
export async function readBytes(file: string): Promise<Buffer> {
  if (!isHttpUrl(file)) return readFile(file);
  const response = await fetch(file);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The extension of a path, or of a URL's path. */
export function extensionOf(file: string): string {
  const path = isHttpUrl(file) ? new URL(file).pathname : file;
  return extname(path).toLowerCase();
}

export function mediaType(file: string): string {
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
    case '.gif':
      return 'image/gif';
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
