/**
 * `stitch share`: upload a cut to OpenStory and get a link anyone can open.
 *
 * The first share signs in with the public API's device code: the command
 * prints a short code, opens the approval page, and polls until the user
 * approves. The API key it gets is kept in ~/.openstory/stitch.json, one per
 * origin. A share is then three steps: POST /api/v1/stitches with the cut,
 * whose media URLs are the bundle's `media/<id>.<ext>` names, one PUT per
 * file to the upload link the response carries, and a POST to its publish
 * link, which checks the files and the stills and makes the page live. The
 * server rewrites the names to its own storage URLs; the printed link is the
 * player page for that cut.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServedCut } from './cli.js';
import { bundledMediaUrl, cutJson } from './cli.js';
import { extensionOf, mediaType, readBytes } from './media-file.js';

type Writer = { write: (text: string) => void };

export type ShareOptions = {
  cut: ServedCut;
  origin: string;
  home: string;
  /** `--portrait-rights`: the basis for using a real person's likeness. */
  portraitRights: string | null;
  stderr: Writer;
  open: (url: string) => void;
  fetch?: typeof fetch;
};

const KEY_FILE = ['.openstory', 'stitch.json'] as const;
const DEVICE_WAIT = '60s';

/** The extensions OpenStory stores for a stitch; the same list as its cut schema. */
const SHARED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp4',
  '.webm',
  '.mov',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
]);

/** The stored key, or a fresh device-code sign-in. */
export async function openStoryApiKey(
  options: Pick<ShareOptions, 'origin' | 'home' | 'stderr' | 'open'> & {
    fetch?: typeof fetch;
  }
): Promise<string> {
  const fetchFn = options.fetch ?? fetch;
  const stored = await storedKey(options.home, options.origin);
  if (stored) return stored;
  return signIn({ ...options, fetch: fetchFn });
}

/** Always signs in again. Used when a stored key is rejected. */
export async function refreshOpenStoryApiKey(
  options: Pick<ShareOptions, 'origin' | 'home' | 'stderr' | 'open'> & {
    fetch?: typeof fetch;
  }
): Promise<string> {
  return signIn({ ...options, fetch: options.fetch ?? fetch });
}

/** Uploads the cut and returns the public link. */
export async function shareCut(options: ShareOptions): Promise<string> {
  const fetchFn = options.fetch ?? fetch;
  const origin = options.origin;
  for (const file of options.cut.files.values()) {
    const ext = extensionOf(file);
    if (ext === '') {
      throw new Error(
        `${file} has no file extension; share a copy that has one`
      );
    }
    if (!SHARED_EXTENSIONS.has(ext)) {
      throw new Error(`${file}: ${ext} is not a type the shared player plays`);
    }
  }
  let key = await storedKey(options.home, origin);
  let fresh = false;
  if (key === null) {
    key = await signIn({ ...options, fetch: fetchFn });
    fresh = true;
  }
  let created = await createStitch(fetchFn, origin, key, options.cut);
  if (!created.ok && created.status === 401 && !fresh) {
    // The stored key was revoked. Sign in once more, then give up.
    key = await signIn({ ...options, fetch: fetchFn });
    created = await createStitch(fetchFn, origin, key, options.cut);
  }
  if (!created.ok) {
    throw created.status === 401
      ? new Error('OpenStory refused the key')
      : created.error;
  }
  const { url, uploadHref, publishHref } = created;
  for (const [id, file] of options.cut.files) {
    const name = bundledMediaUrl(id, file).slice('media/'.length);
    const type = mediaType(file);
    const target = new URL(
      uploadHref
        .replace('{name}', encodeURIComponent(name))
        .replace('{type}', encodeURIComponent(type)),
      origin
    );
    // ponytail: the whole file sits in memory for the PUT; the upload route
    // takes one body up to ~100 MB. Stream and use the multipart route past that.
    const response = await fetchFn(target, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': type },
      body: new Uint8Array(await readBytes(file)),
    });
    if (!response.ok) {
      throw new Error(
        `${file}: upload failed (${response.status}) ${await errorText(response)}`
      );
    }
  }
  const published = await fetchFn(new URL(publishHref, origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      portraitAttestation:
        options.portraitRights === null
          ? null
          : {
              statementVersion: 'portrait-rights-v1',
              authorizationBasis: options.portraitRights,
            },
    }),
  });
  if (!published.ok) {
    const { code, text } = await errorInfo(published);
    throw new Error(
      code === 'ATTESTATION_REQUIRED'
        ? `${text} Run stitch share again with --portrait-rights <basis>.`
        : `OpenStory did not publish the cut (${published.status}) ${text}`
    );
  }
  return url;
}

type Created =
  | { ok: true; url: string; uploadHref: string; publishHref: string }
  | { ok: false; status: number; error: Error };

async function createStitch(
  fetchFn: typeof fetch,
  origin: string,
  key: string,
  cut: ServedCut
): Promise<Created> {
  const response = await fetchFn(new URL('/api/v1/stitches', origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cut: JSON.parse(cutJson(cut)) }),
  });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: new Error(
        `OpenStory did not take the cut (${response.status}) ${await errorText(response)}`
      ),
    };
  }
  const record = recordOf(await response.json());
  const url = record.url;
  const links = recordOf(record._links);
  const uploadHref = recordOf(links.upload).href;
  const publishHref = recordOf(links.publish).href;
  if (
    typeof url !== 'string' ||
    typeof uploadHref !== 'string' ||
    typeof publishHref !== 'string'
  ) {
    throw new Error('OpenStory answered without a link to upload to');
  }
  return { ok: true, url, uploadHref, publishHref };
}

/** A JSON object's fields, or none: a wrong shape reads as missing fields. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function stringOf(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`OpenStory answered without ${label}`);
}

/**
 * The error envelope's message, with each field issue a 400 carries
 * (`details.issues`, as `path: message`), else the raw body.
 */
async function errorText(response: Response): Promise<string> {
  return (await errorInfo(response)).text;
}

/** The envelope's `error.code` beside the text, for a branch that must not rest on wording. */
async function errorInfo(
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

type KeyFile = { keys: Record<string, string> };

async function readKeyFile(home: string): Promise<KeyFile> {
  let text: string;
  try {
    text = await readFile(join(home, ...KEY_FILE), 'utf8');
  } catch (error) {
    // Only a missing file means "no keys yet". Anything else would be
    // overwritten by the next sign-in, taking every other origin's key with it.
    if (isMissingFile(error)) return { keys: {} };
    throw new Error(
      `~/${KEY_FILE.join('/')} is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`~/${KEY_FILE.join('/')} is not JSON; fix or remove it`);
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

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function storedKey(home: string, origin: string): Promise<string | null> {
  return (await readKeyFile(home)).keys[origin] ?? null;
}

async function storeKey(
  home: string,
  origin: string,
  key: string
): Promise<void> {
  const file = await readKeyFile(home);
  file.keys[origin] = key;
  const dir = join(home, KEY_FILE[0]);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, KEY_FILE[1]), JSON.stringify(file, null, 2), {
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
async function signIn(
  options: Pick<ShareOptions, 'origin' | 'home' | 'stderr' | 'open'> & {
    fetch: typeof fetch;
  }
): Promise<string> {
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
          ? 'The sign-in code expired. Run stitch share again'
          : `Sign-in failed (${response.status}) ${await errorText(response)}`
    );
  }
}
