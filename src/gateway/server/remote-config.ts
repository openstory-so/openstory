/** Whether this install runs providers it has no key for on the hosted gateway (#2438). */

import { getEnv } from '#env';

export const DEFAULT_GATEWAY_URL = 'https://openstory.so';

/** An `OPENSTORY_API_KEY` is set. E2E stays on the mocks unless `OPENSTORY_GATEWAY_URL` is set too. */
export function remoteGatewayConfigured(): boolean {
  const env = getEnv();
  if (!env.OPENSTORY_API_KEY) return false;
  return env.E2E_TEST !== 'true' || Boolean(env.OPENSTORY_GATEWAY_URL);
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
