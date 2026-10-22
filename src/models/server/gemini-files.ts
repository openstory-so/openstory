/**
 * Gemini Files API for a stored clip (#1930). The clip streams out of R2
 * into one resumable upload, so it never sits in Worker memory: the
 * `@tanstack/ai-gemini` files adapter takes a `Blob`, which would hold it.
 * Works the same with no public CDN (local dev, deploy-button installs).
 */

import { readStorageStream, storageObjectSize } from '#storage';
import { getEnv } from '#env';
import { z } from 'zod';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'models', 'gemini-files']);

export type GeminiFile = { name: string; uri: string; mimeType: string };

const fileSchema = z.object({
  name: z.string(),
  uri: z.string(),
  mimeType: z.string(),
  state: z.enum(['STATE_UNSPECIFIED', 'PROCESSING', 'ACTIVE', 'FAILED']),
});

const POLL_MS = 1_000;
const MAX_WAIT_MS = 120_000;

function apiBase(): string {
  return (
    getEnv().GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'
  );
}

async function geminiFetch(
  url: string,
  apiKey: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }
): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, 'x-goog-api-key': apiKey },
  });
  if (!response.ok) {
    throw new Error(
      `Gemini Files ${response.status}: ${(await response.text()).slice(0, 300)}`
    );
  }
  return response;
}

/** Upload the clip at storage `key` and wait until Gemini can read it. */
export async function uploadClipToGemini(
  key: string,
  mimeType: string,
  apiKey: string
): Promise<GeminiFile> {
  const size = await storageObjectSize(key);
  if (!size) throw new Error(`Stored clip is missing or empty: ${key}`);

  const start = await geminiFetch(`${apiBase()}/upload/v1beta/files`, apiKey, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(size),
      'x-goog-upload-header-content-type': mimeType,
    },
    body: JSON.stringify({ file: { display_name: key.split('/').pop() } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini Files: no upload URL');

  const stream = await readStorageStream(key, { offset: 0, length: size });
  if (!stream) throw new Error(`Stored clip disappeared: ${key}`);
  // workerd needs a known length to stream a request body.
  let body: ReadableStream<Uint8Array> = stream.body;
  if (typeof FixedLengthStream !== 'undefined') {
    const fixed = new FixedLengthStream(size);
    void stream.body.pipeTo(fixed.writable).catch((error: unknown) => {
      // The upload fetch fails too; this keeps the storage cause.
      logger.warn('Reading a stored clip for Gemini failed', { key, error });
    });
    body = fixed.readable;
  }
  const finished = await geminiFetch(uploadUrl, apiKey, {
    method: 'POST',
    headers: {
      'content-length': String(size),
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
    },
    body,
    // Node's fetch (tests, scripts) refuses a stream body without it.
    duplex: 'half',
  } as RequestInit & { headers: Record<string, string> });
  const uploaded: unknown = await finished.json();
  const { name } = z
    .object({ file: z.object({ name: z.string() }) })
    .parse(uploaded).file;
  // From here the clip is on Google: every failure deletes it.
  try {
    return await waitUntilActive(
      z.object({ file: fileSchema }).parse(uploaded).file,
      apiKey
    );
  } catch (error) {
    await deleteGeminiFile(name, apiKey).catch((deleteError: unknown) => {
      logger.warn('Could not delete a Gemini file', { name, deleteError });
    });
    throw error;
  }
}

async function waitUntilActive(
  uploaded: z.infer<typeof fileSchema>,
  apiKey: string
): Promise<GeminiFile> {
  let file = uploaded;
  const deadline = Date.now() + MAX_WAIT_MS;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) {
      throw new Error('Gemini took too long to read the clip');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const polled = await geminiFetch(
      `${apiBase()}/v1beta/${file.name}`,
      apiKey,
      {}
    );
    file = fileSchema.parse(await polled.json());
  }
  if (file.state !== 'ACTIVE') {
    throw new Error(`Gemini could not read the clip (${file.state})`);
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType };
}

/** Files expire after 48h anyway; deleting keeps a person's clip off Google sooner. */
export async function deleteGeminiFile(
  name: string,
  apiKey: string
): Promise<void> {
  await geminiFetch(`${apiBase()}/v1beta/${name}`, apiKey, {
    method: 'DELETE',
  });
}
