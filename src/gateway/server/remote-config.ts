/** Whether this install runs providers it has no key for on the hosted gateway (#2438). */

import { getEnv } from '#env';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';

const DEFAULT_GATEWAY_URL = 'https://openstory.so';

/** An `OPENSTORY_API_KEY` is set. E2E stays on the mocks unless `OPENSTORY_GATEWAY_URL` is set too. */
export function remoteGatewayConfigured(): boolean {
  const env = getEnv();
  if (!env.OPENSTORY_API_KEY) return false;
  return env.E2E_TEST !== 'true' || Boolean(env.OPENSTORY_GATEWAY_URL);
}

/** Every platform key a call on this server could spend. */
const PLATFORM_KEYS = [
  'FAL_KEY',
  'OPENROUTER_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'ARK_API_KEY',
  'ELEVENLABS_API_KEY',
  'SEED_SPEECH_API_KEY',
] as const;

/**
 * An OpenStory key and no platform key: every paid call this server makes is
 * routed remote or refused before it spends, so there is nothing to hold here.
 * One platform key and every run holds as before (#2438).
 */
export function onlyHostedGatewaySpends(): boolean {
  if (!remoteGatewayConfigured()) return false;
  const env = getEnv();
  return PLATFORM_KEYS.every((name) => !env[name]);
}

const REMOTE = 'remote:';

/** A hosted job's handle on this install: the prefix and the hosted job id, opaque here. */
export function remoteHandle(jobId: string): string {
  return `${REMOTE}${jobId}`;
}

/** The hosted job a handle names, or null for an in-process handle. */
export function remoteJobOf(handle: string): string | null {
  return handle.startsWith(REMOTE) ? handle.slice(REMOTE.length) : null;
}

/** Read inside the call that spends it: never on a payload, a URL or a log. */
function remoteGateway(): { base: string; key: string } {
  const env = getEnv();
  if (!env.OPENSTORY_API_KEY) {
    throw new NonRetryableError('OPENSTORY_API_KEY is not set on this install');
  }
  return {
    base: (env.OPENSTORY_GATEWAY_URL ?? DEFAULT_GATEWAY_URL).replace(/\/$/, ''),
    key: env.OPENSTORY_API_KEY,
  };
}

const errorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/** One request to the hosted gateway. A refusal (a 4xx other than 429) is final and reads as the hosted side wrote it. */
export async function hostedFetch(
  path: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Readonly<Record<string, string>>;
    body?: BodyInit;
    signal?: AbortSignal;
  }
): Promise<Response> {
  const { base, key } = remoteGateway();
  const response = await fetch(`${base}/api/v1/gateway/${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${key}` },
  });
  if (response.ok) return response;
  const text = await response.text();
  const parsed = errorEnvelope.safeParse(safeJson(text));
  const reason = parsed.success
    ? `${parsed.data.error.code}: ${parsed.data.error.message}`
    : `HTTP ${response.status}`;
  const message = `The hosted gateway refused this call (${reason})`;
  if (
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 429
  ) {
    throw new NonRetryableError(message);
  }
  throw new Error(message);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
