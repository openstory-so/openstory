/** Talking to OpenStory: the version header, the 426 answer, and the error envelope. */

import { readFileSync } from 'node:fs';

/** Mirrors CLI_VERSION_HEADER on the server (src/platform/server/api-v1/cli-version.ts). */
export const CLI_VERSION_HEADER = 'X-OpenStory-CLI';

export const CLI_VERSION = readVersion();

function readVersion(): string {
  const text = readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8'
  );
  const version = recordOf(JSON.parse(text)).version;
  if (typeof version !== 'string')
    throw new Error('package.json has no version');
  return version;
}

/** The key allows 10 requests a second. Two are spare for anything else on that key. */
const REQUESTS_PER_SECOND = 8;
const WINDOW_MS = 1000;
const RATE_LIMIT_RETRIES = 5;

export type FetchClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const realClock: FetchClock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Every request to OpenStory carries the CLI version; a 426 becomes the
 * update message. Requests stay under the key's rate limit, and a
 * RATE_LIMITED 429 waits for Retry-After and tries again.
 */
export function versionedFetch(
  fetchFn: typeof fetch,
  version: string = CLI_VERSION,
  clock: FetchClock = realClock
): typeof fetch {
  const sent: number[] = [];
  let tail = Promise.resolve();
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const slot = tail.then(() => takeSlot(sent, clock));
      tail = slot.then(
        () => undefined,
        () => undefined
      );
      await slot;
      const headers = new Headers(init?.headers);
      headers.set(CLI_VERSION_HEADER, version);
      const response = await fetchFn(input, { ...init, headers });
      if (response.status === 426) {
        throw new Error(
          `OpenStory needs a newer @openstory/cli (you have ${version}). Run npx @openstory/cli@latest. ${await errorText(response)}`.trim()
        );
      }
      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
        return response;
      }
      const text = await response.text();
      if (rateLimitCode(text) !== 'RATE_LIMITED') {
        return new Response(text, {
          status: response.status,
          headers: response.headers,
        });
      }
      await clock.sleep(retryAfterMs(response));
    }
  };
}

/** One slot in the rolling second, in line, so a burst cannot slip past the count. */
async function takeSlot(sent: number[], clock: FetchClock): Promise<void> {
  for (;;) {
    const now = clock.now();
    while (sent[0] !== undefined && now - sent[0] >= WINDOW_MS) sent.shift();
    if (sent.length < REQUESTS_PER_SECOND) {
      sent.push(now);
      return;
    }
    const oldest = sent[0] ?? now;
    await clock.sleep(WINDOW_MS - (now - oldest));
  }
}

function retryAfterMs(response: Response): number {
  const header = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(header) || header < 0) return WINDOW_MS;
  return Math.min(header * 1000, 10_000);
}

function rateLimitCode(text: string): string | null {
  try {
    const error = recordOf(recordOf(JSON.parse(text)).error);
    return typeof error.code === 'string' ? error.code : null;
  } catch {
    return null;
  }
}

/** A JSON object's fields, or none: a wrong shape reads as missing fields. */
export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function stringOf(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`OpenStory answered without ${label}`);
}

/**
 * The error envelope's message, with each field issue a 400 carries
 * (`details.issues`, as `path: message`), else the raw body.
 */
export async function errorText(response: Response): Promise<string> {
  return (await errorInfo(response)).text;
}

/** The envelope's `error.code` beside the text, for a branch that must not rest on wording. */
export async function errorInfo(
  response: Response
): Promise<{ code: string | null; text: string }> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = recordOf(JSON.parse(text));
    const error = recordOf(parsed.error);
    const code = typeof error.code === 'string' ? error.code : null;
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : (error.message ?? parsed.message);
    if (typeof message !== 'string') return { code, text };
    const issues = recordOf(error.details).issues;
    if (!Array.isArray(issues)) return { code, text: message };
    const lines = issues.map((issue) => {
      const record = recordOf(issue);
      const path = Array.isArray(record.path) ? record.path.join('.') : '';
      const text = typeof record.message === 'string' ? record.message : '';
      return `${path}: ${text}`;
    });
    return { code, text: [message, ...lines].join('\n  ') };
  } catch {
    return { code: null, text };
  }
}
