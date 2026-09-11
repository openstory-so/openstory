/**
 * ElevenLabs e2e mock (#1552).
 *
 * TanStack AI wraps TTS (`elevenlabsSpeech`) but not Voice Design — that
 * goes through `@elevenlabs/elevenlabs-js` (`textToVoice.design`). Neither
 * path is OpenAI-shaped, so they cannot share the xAI LLMock on :4011.
 *
 * This server is replay-only against `fixtures/recorded/elevenlabs/`. It
 * does not reverse-proxy `req.url` (CodeQL `js/request-forgery`). Live
 * recording, when a product call exists, must fetch a hardcoded ElevenLabs
 * URL the way `xaiJsonImageEditsMount` fetches `https://api.x.ai/v1/images/edits`.
 *
 * Playwright points `ELEVENLABS_BASE_URL` here. The adapter/SDK default
 * host is `https://api.elevenlabs.io` (no `/v1` suffix — paths include it).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';

export const ELEVENLABS_AIMOCK_PORT = 4012;
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

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  // Drain the body so the client isn't left hanging; replay ignores it.
  for await (const _chunk of req) {
    /* empty */
  }
  const path = req.url ?? '/';
  const method = req.method ?? 'GET';

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
