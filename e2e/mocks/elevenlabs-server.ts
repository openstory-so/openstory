/**
 * ElevenLabs e2e mock (#1552).
 *
 * Native TTS and Voice Design are not OpenAI-shaped, so they cannot share
 * the xAI LLMock on :4011. This is a small HTTP reverse-proxy that:
 *
 * - Replay: matches recorded fixtures under `fixtures/recorded/elevenlabs/`.
 * - Record (`E2E_RECORD=1`): forwards to https://api.elevenlabs.io and
 *   writes the response as a fixture.
 *
 * Playwright points `ELEVENLABS_BASE_URL` at this host. The SDK default
 * base is `https://api.elevenlabs.io` (no `/v1` suffix — paths include it).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';
import { E2E_RECORDING } from '../recording-mode';

export const ELEVENLABS_AIMOCK_PORT = 4012;
const UPSTREAM = 'https://api.elevenlabs.io';
const FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../fixtures/recorded/elevenlabs'
);

type Fixture = {
  match: { method: string; pathPrefix: string };
  status: number;
  contentType: string;
  bodyBase64: string;
};

let server: http.Server | null = null;

function isFixture(value: unknown): value is Fixture {
  if (!value || typeof value !== 'object') return false;
  if (
    !('match' in value) ||
    !('status' in value) ||
    !('contentType' in value) ||
    !('bodyBase64' in value)
  ) {
    return false;
  }
  const { match, status, contentType, bodyBase64 } = value;
  if (!match || typeof match !== 'object') return false;
  if (!('method' in match) || !('pathPrefix' in match)) return false;
  return (
    typeof match.method === 'string' &&
    typeof match.pathPrefix === 'string' &&
    typeof status === 'number' &&
    typeof contentType === 'string' &&
    typeof bodyBase64 === 'string'
  );
}

function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURE_DIR)) return [];
  const out: Fixture[] = [];
  for (const name of readdirSync(FIXTURE_DIR)) {
    if (!name.endsWith('.json')) continue;
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(FIXTURE_DIR, name), 'utf8')
    );
    if (isFixture(parsed)) out.push(parsed);
  }
  return out;
}

function matchFixture(
  method: string,
  path: string,
  fixtures: Fixture[]
): Fixture | undefined {
  const normalised = path.split('?')[0] ?? path;
  return fixtures.find(
    (fixture) =>
      fixture.match.method === method &&
      normalised.startsWith(fixture.match.pathPrefix)
  );
}

function writeFixture(
  method: string,
  path: string,
  status: number,
  contentType: string,
  body: Buffer
): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const pathPrefix = path.startsWith('/v1/text-to-speech/')
    ? '/v1/text-to-speech/'
    : path.startsWith('/v1/text-to-voice/')
      ? '/v1/text-to-voice/'
      : (path.split('?')[0] ?? path);
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const kind = pathPrefix.includes('text-to-speech')
    ? 'tts'
    : pathPrefix.includes('text-to-voice')
      ? 'voice-design'
      : 'other';
  writeFileSync(
    resolve(FIXTURE_DIR, `${kind}-${stamp}-${hash}.json`),
    JSON.stringify(
      {
        match: { method, pathPrefix },
        status,
        contentType,
        bodyBase64: body.toString('base64'),
      } satisfies Fixture,
      null,
      2
    )
  );
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  const path = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (E2E_RECORDING) {
    const headers = new Headers();
    const apiKey = req.headers['xi-api-key'];
    if (typeof apiKey === 'string') headers.set('xi-api-key', apiKey);
    const contentType = req.headers['content-type'];
    if (typeof contentType === 'string') {
      headers.set('content-type', contentType);
    }
    const upstream = await fetch(`${UPSTREAM}${path}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    const upstreamType =
      upstream.headers.get('content-type') ?? 'application/octet-stream';
    writeFixture(method, path, upstream.status, upstreamType, buf);
    res.writeHead(upstream.status, { 'content-type': upstreamType });
    res.end(buf);
    return;
  }

  const fixture = matchFixture(method, path, loadFixtures());
  if (!fixture) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'no elevenlabs fixture',
        method,
        path,
      })
    );
    return;
  }
  res.writeHead(fixture.status, { 'content-type': fixture.contentType });
  res.end(Buffer.from(fixture.bodyBase64, 'base64'));
}

export async function startElevenLabsMock(): Promise<string> {
  if (server) return `http://127.0.0.1:${ELEVENLABS_AIMOCK_PORT}`;
  server = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      console.error('[e2e] elevenlabs mock failed', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolveStart, reject) => {
    server?.once('error', reject);
    server?.listen(ELEVENLABS_AIMOCK_PORT, '127.0.0.1', () => resolveStart());
  });
  const url = `http://127.0.0.1:${ELEVENLABS_AIMOCK_PORT}`;
  console.log(`[e2e] elevenlabs mock started at ${url}`);
  return url;
}

export async function stopElevenLabsMock(): Promise<void> {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise<void>((resolveStop, reject) => {
    current.close((error) => (error ? reject(error) : resolveStop()));
  });
}
