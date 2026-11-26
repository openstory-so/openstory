/** Whether this install runs providers it has no key for on the hosted gateway (#2438). */

import { getEnv } from '#env';

export const DEFAULT_GATEWAY_URL = 'https://openstory.so';

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
