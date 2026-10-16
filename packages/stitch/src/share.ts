/**
 * `stitch share`: upload a cut to OpenStory and get a link anyone can open.
 *
 * The first share signs in with the public API's device code: the command
 * prints a short code, opens the approval page, and polls until the user
 * approves. The API key it gets is kept in ~/.openstory/stitch.json, one per
 * origin. A share is then two calls: POST /api/v1/stitches with the cut, whose
 * media URLs are the bundle's `media/<id>.<ext>` names, and one PUT per file
 * to the upload link the response carries. The server rewrites the names to
 * its own storage URLs; the printed link is the player page for that cut.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ServedCut } from './cli.js';
import { bundledMediaUrl, cutJson } from './cli.js';
import { mediaType, readBytes } from './media-file.js';

type Writer = { write: (text: string) => void };

export type ShareOptions = {
  cut: ServedCut;
  origin: string;
  home: string;
  stderr: Writer;
  open: (url: string) => void;
  fetch?: typeof fetch;
};

const KEY_FILE = ['.openstory', 'stitch.json'] as const;
const DEVICE_WAIT = '60s';

/** Uploads the cut and returns the public link. */
export async function shareCut(options: ShareOptions): Promise<string> {
  const fetchFn = options.fetch ?? fetch;
  const origin = options.origin;
  let key = await storedKey(options.home, origin);
  let fresh = false;
  if (key === null) {
    key = await signIn({ ...options, fetch: fetchFn });
    fresh = true;
  }
  let created = await createStitch(fetchFn, origin, key, options.cut);
  if (created.status === 401 && !fresh) {
    // The stored key was revoked. Sign in once more, then give up.
    key = await signIn({ ...options, fetch: fetchFn });
    created = await createStitch(fetchFn, origin, key, options.cut);
  }
  if (created.status === 401) throw new Error('OpenStory refused the key');
  if (!created.ok) throw created.error;
  const { url, uploadHref } = created;
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
  return url;
}

type Created =
  | { ok: true; status: number; url: string; uploadHref: string }
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
  const href = recordOf(links.upload).href;
  if (typeof url !== 'string' || typeof href !== 'string') {
    throw new Error('OpenStory answered without a link to upload to');
  }
  return { ok: true, status: response.status, url, uploadHref: href };
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

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = recordOf(JSON.parse(text));
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : (recordOf(parsed.error).message ?? parsed.message);
    return typeof message === 'string' ? message : text;
  } catch {
    return text;
  }
}

type KeyFile = { keys: Record<string, string> };

async function readKeyFile(home: string): Promise<KeyFile> {
  try {
    const keys = recordOf(
      recordOf(JSON.parse(await readFile(join(home, ...KEY_FILE), 'utf8'))).keys
    );
    return {
      keys: Object.fromEntries(
        Object.entries(keys).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
    };
  } catch {
    // Missing or unreadable: no keys yet.
  }
  return { keys: {} };
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
    if (response.status === 428) continue;
    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, code.interval * 1000));
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
