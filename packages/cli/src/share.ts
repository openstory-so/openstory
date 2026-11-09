/**
 * `openstory share`: upload a cut to OpenStory and get a link anyone can open.
 *
 * A share is three steps: POST /api/v1/stitches with the cut, whose media
 * URLs are the bundle's `media/<id>.<ext>` names, one PUT per file to the
 * upload link the response carries, and a POST to its publish link, which
 * checks the files and the stills and makes the page live. The server
 * rewrites the names to its own storage URLs; the printed link is the player
 * page for that cut. The first share signs in (see login.ts).
 */

import type { ServedCut } from '@openstory/stitch/bundle';
import {
  buildCut,
  bundledMediaUrl,
  cutJson,
  extensionOf,
  mediaType,
  parseCut,
  readBytes,
} from '@openstory/stitch/bundle';

import { errorInfo, errorText, recordOf } from './api.js';
import type { CliContext, Command } from './context.js';
import { parseOrigin } from './context.js';
import { signIn, storedKey } from './login.js';

export type ShareOptions = Pick<
  CliContext,
  'home' | 'stderr' | 'open' | 'fetch'
> & {
  cut: ServedCut;
  origin: string;
  /** `--portrait-rights`: the basis for using a real person's likeness. */
  portraitRights: string | null;
};

export const share: Command = {
  usage:
    'openstory share [--origin url] [--portrait-rights basis] [cut options] <file>...',
  async run(args, context) {
    const { origin, rest } = parseOrigin(args);
    let portraitRights: string | null = null;
    const cutArgs: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i] ?? '';
      if (arg === '--portrait-rights') {
        const value = rest[i + 1]?.trim();
        if (value === undefined || value === '' || value.startsWith('-')) {
          throw new Error(
            '--portrait-rights needs the basis for using the person’s likeness (a release reference, "self", a contract id)'
          );
        }
        portraitRights = value;
        i += 1;
      } else cutArgs.push(arg);
    }
    const cut = await buildCut(
      await parseCut(cutArgs, context.cwd),
      bundledMediaUrl
    );
    const url = await shareCut({ ...context, cut, origin, portraitRights });
    context.stdout.write(`${url}\n`);
  },
};

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

/** Uploads the cut and returns the public link. */
export async function shareCut(options: ShareOptions): Promise<string> {
  const fetchFn = options.fetch;
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
    key = await signIn(options);
    fresh = true;
  }
  let created = await createStitch(fetchFn, origin, key, options.cut);
  if (!created.ok && created.status === 401 && !fresh) {
    // The stored key was revoked. Sign in once more, then give up.
    key = await signIn(options);
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
        ? `${text} Run openstory share again with --portrait-rights <basis>.`
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
