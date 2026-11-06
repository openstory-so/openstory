/**
 * HTTP entrypoint for the video-export container.
 *
 * Routes:
 *   GET  /ping              → liveness (the Cloudflare Container ping endpoint)
 *   POST /export            → body = ExportJob (JSON); responds with the MP4
 *                             bytes and an `x-export-meta` header.
 *   POST /transcode-audio   → body = audio bytes (M4A, OGG, FLAC, …); responds
 *                             with 16-bit 48 kHz mono WAV (#2265).
 *
 * The Worker streams either response straight into R2.
 */

import { registerMediabunnyServer } from '@mediabunny/server';
import http from 'node:http';
import { exportSequence } from './export.js';
import { transcodeAudioToWav, UnreadableAudioError } from './transcode.js';
import type { ExportJob } from './types.js';

registerMediabunnyServer();

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = 2_000_000;
/** Matches the Worker's URL media cap (`MAX_URL_MEDIA_BYTES`). */
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

class BadRequestError extends Error {}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequestError('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BadRequestError('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BadRequestError('Audio file is too large'));
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BadRequestError('Audio file is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJob(body: unknown): ExportJob {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('Job must be an object');
  }
  const { scenes, musicUrl, musicLoudnessGainDb } = body as Record<
    string,
    unknown
  >;
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new BadRequestError('Job.scenes must be a non-empty array');
  }
  const parsedScenes = scenes.map((s, i) => {
    if (typeof s !== 'object' || s === null) {
      throw new BadRequestError(`Job.scenes[${i}] must be an object`);
    }
    const { orderIndex, videoUrl } = s as Record<string, unknown>;
    if (typeof orderIndex !== 'number' || typeof videoUrl !== 'string') {
      throw new BadRequestError(
        `Job.scenes[${i}] needs orderIndex:number, videoUrl:string`
      );
    }
    return { orderIndex, videoUrl };
  });
  if (musicUrl !== null && typeof musicUrl !== 'string') {
    throw new BadRequestError('Job.musicUrl must be a string or null');
  }
  if (musicLoudnessGainDb !== null && typeof musicLoudnessGainDb !== 'number') {
    throw new BadRequestError(
      'Job.musicLoudnessGainDb must be a number or null'
    );
  }
  return { scenes: parsedScenes, musicUrl, musicLoudnessGainDb };
}

const server = http.createServer((req, res) => {
  void (async () => {
    const url = req.url ?? '/';
    try {
      if (
        req.method === 'GET' &&
        (url === '/ping' || url === '/' || url === '/health')
      ) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST' && url.startsWith('/transcode-audio')) {
        const wav = await transcodeAudioToWav(
          await readRawBody(req, MAX_AUDIO_BYTES)
        );
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(wav.byteLength),
        });
        res.end(wav);
        return;
      }

      if (req.method === 'POST' && url.startsWith('/export')) {
        const job = parseJob(await readJsonBody(req));
        const { buffer, meta } = await exportSequence(job);
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(buffer.byteLength),
          'x-export-meta': encodeURIComponent(JSON.stringify(meta)),
        });
        res.end(Buffer.from(buffer));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      const status =
        err instanceof BadRequestError || err instanceof UnreadableAudioError
          ? 400
          : 500;
      const message = err instanceof Error ? err.message : 'Export failed';
      console.error('[video-export] request failed:', err);
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      } else {
        res.destroy();
      }
    }
  })();
});

server.listen(PORT, () => {
  console.log(`[video-export] listening on :${PORT}`);
});
