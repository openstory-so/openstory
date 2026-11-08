/** Refuses an @openstory/cli older than the server can serve (426). Other callers send no header and pass. */

import { apiJsonError } from '@/platform/server/api-v1/errors';

export const CLI_VERSION_HEADER = 'X-OpenStory-CLI';

/** Raise when a server change breaks an older CLI; 0.0.0 blocks nothing. */
export const MIN_CLI_VERSION = '0.0.0';

export function cliVersionRefusal(
  headers: Headers,
  minimum: string = MIN_CLI_VERSION
): Response | null {
  const sent = headers.get(CLI_VERSION_HEADER);
  if (sent === null) return null;
  const version = parseVersion(sent);
  const floor = parseVersion(minimum);
  if (!version || !floor || compare(version, floor) >= 0) return null;
  return apiJsonError(
    426,
    'CLI_TOO_OLD',
    `This server needs @openstory/cli ${minimum} or later (you have ${sent}). Update @openstory/cli: npx @openstory/cli@latest`
  );
}

function parseVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
