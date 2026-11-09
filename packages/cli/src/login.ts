/**
 * Signing in to OpenStory with the public API's device code, and the keys it
 * leaves in ~/.openstory/credentials.json, one per origin.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { errorText, recordOf, stringOf } from './api.js';
import type { CliContext, Command } from './context.js';
import { parseOrigin } from './context.js';

const DIR = '.openstory';
const KEY_FILE = 'credentials.json';
/** Where stitch kept the keys before 0.5.0. */
const OLD_KEY_FILE = 'stitch.json';
const DEVICE_WAIT = '60s';

export type SignInOptions = Pick<
  CliContext,
  'home' | 'stderr' | 'open' | 'fetch'
> & {
  origin: string;
};

export const login: Command = {
  usage: 'openstory login [--origin url]',
  async run(args, context) {
    const { origin, rest } = parseOrigin(args);
    if (rest[0] !== undefined) throw new Error(`Unknown argument: ${rest[0]}`);
    await signIn({ ...context, origin });
  },
};

/** Renames stitch's key file once; never over an existing credentials file. */
export async function moveOldCredentials(home: string): Promise<void> {
  const dir = join(home, DIR);
  if (await exists(join(dir, KEY_FILE))) return;
  if (!(await exists(join(dir, OLD_KEY_FILE)))) return;
  await rename(join(dir, OLD_KEY_FILE), join(dir, KEY_FILE));
}

/** The stored key, or a fresh device-code sign-in. */
export async function openStoryApiKey(options: SignInOptions): Promise<string> {
  return (await storedKey(options.home, options.origin)) ?? signIn(options);
}

export async function storedKey(
  home: string,
  origin: string
): Promise<string | null> {
  return (await readKeyFile(home)).keys[origin] ?? null;
}

type KeyFile = { keys: Record<string, string> };

async function readKeyFile(home: string): Promise<KeyFile> {
  let text: string;
  try {
    text = await readFile(join(home, DIR, KEY_FILE), 'utf8');
  } catch (error) {
    // Only a missing file means "no keys yet". Anything else would be
    // overwritten by the next sign-in, taking every other origin's key with it.
    if (isMissingFile(error)) return { keys: {} };
    throw new Error(
      `~/${DIR}/${KEY_FILE} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`~/${DIR}/${KEY_FILE} is not JSON; fix or remove it`);
  }
  const keys = recordOf(recordOf(parsed).keys);
  return {
    keys: Object.fromEntries(
      Object.entries(keys).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    ),
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

export function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function storeKey(
  home: string,
  origin: string,
  key: string
): Promise<void> {
  const file = await readKeyFile(home);
  file.keys[origin] = key;
  const dir = join(home, DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, KEY_FILE), JSON.stringify(file, null, 2), {
    mode: 0o600,
  });
}

/**
 * The sign-in page must be on the server we are talking to: the string goes
 * to the OS launcher, so no other origin or scheme is passed through.
 */
function sameOriginUrl(value: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('OpenStory answered with an unreadable sign-in page');
  }
  if (url.origin !== origin) {
    throw new Error(`The sign-in page is not on ${origin}`);
  }
  return url.href;
}

const sleep = (seconds: number) =>
  new Promise((r) => setTimeout(r, seconds * 1000));

/** Device-code sign-in (RFC 8628 shape); stores and returns the API key. */
export async function signIn(options: SignInOptions): Promise<string> {
  const { origin, fetch: fetchFn } = options;
  const started = await fetchFn(new URL('/api/v1/device/code', origin), {
    method: 'POST',
  });
  if (!started.ok) {
    throw new Error(
      `OpenStory could not start a sign-in (${started.status}) ${await errorText(started)}`
    );
  }
  const answer = recordOf(await started.json());
  const code = {
    deviceCode: stringOf(answer.device_code, 'a device code'),
    userCode: stringOf(answer.user_code, 'a user code'),
    verifyUrl: sameOriginUrl(
      stringOf(answer.verification_url_complete, 'a sign-in page'),
      origin
    ),
    interval: typeof answer.interval === 'number' ? answer.interval : 5,
  };
  options.stderr.write(
    `Sign in to OpenStory: open ${code.verifyUrl} and enter ${code.userCode}\n`
  );
  options.open(code.verifyUrl);
  const poll = new URL('/api/v1/device/token', origin);
  poll.searchParams.set('device_code', code.deviceCode);
  poll.searchParams.set('wait', DEVICE_WAIT);
  for (;;) {
    const response = await fetchFn(poll);
    if (response.ok) {
      const key = stringOf(recordOf(await response.json()).api_key, 'a key');
      await storeKey(options.home, origin, key);
      options.stderr.write('Signed in.\n');
      return key;
    }
    // OpenStory long-polls on `wait`, so a 428 comes back after a minute; a
    // server that answers at once is paced by its interval, like a 429.
    if (response.status === 428 || response.status === 429) {
      await sleep(code.interval);
      continue;
    }
    throw new Error(
      response.status === 403
        ? 'The sign-in was denied'
        : response.status === 410
          ? 'The sign-in code expired. Run the command again'
          : `Sign-in failed (${response.status}) ${await errorText(response)}`
    );
  }
}
