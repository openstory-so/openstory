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

/** Every request to OpenStory carries the CLI version; a 426 becomes the update message. */
export function versionedFetch(
  fetchFn: typeof fetch,
  version: string = CLI_VERSION
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(CLI_VERSION_HEADER, version);
    const response = await fetchFn(input, { ...init, headers });
    if (response.status === 426) {
      throw new Error(
        `OpenStory needs a newer @openstory/cli (you have ${version}). Run npx @openstory/cli@latest. ${await errorText(response)}`.trim()
      );
    }
    return response;
  };
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
