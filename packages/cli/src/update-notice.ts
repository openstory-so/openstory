/** At most one npm registry check a day; a newer version becomes a one-line hint. Never updates itself. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { recordOf } from './api.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/@openstory/cli/latest';
const CACHE_FILE = ['.openstory', 'cli-update.json'] as const;

export type UpdateCheckOptions = {
  home: string;
  current: string;
  now: number;
  /** Plain fetch: the registry never gets the OpenStory version header. */
  fetch: typeof fetch;
  timeoutMs?: number;
};

/** The hint to print, or null. Swallows every error. */
export async function updateNotice(
  options: UpdateCheckOptions
): Promise<string | null> {
  try {
    const latest = await latestVersion(options);
    return latest !== null && isNewer(latest, options.current)
      ? `openstory ${latest} is out (you have ${options.current}): npx @openstory/cli@latest\n`
      : null;
  } catch {
    return null;
  }
}

async function latestVersion(
  options: UpdateCheckOptions
): Promise<string | null> {
  const file = join(options.home, ...CACHE_FILE);
  const cached = recordOf(
    JSON.parse(await readFile(file, 'utf8').catch(() => '{}'))
  );
  const cachedLatest = typeof cached.latest === 'string' ? cached.latest : null;
  if (
    typeof cached.checkedAt === 'number' &&
    options.now - cached.checkedAt < DAY_MS
  ) {
    return cachedLatest;
  }
  // Stamp first, so a failed or slow check still waits a day.
  await mkdir(join(options.home, CACHE_FILE[0]), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ checkedAt: options.now, latest: cachedLatest })
  );
  const response = await options.fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 1500),
  });
  if (!response.ok) return cachedLatest;
  const latest = recordOf(await response.json()).version;
  if (typeof latest !== 'string') return cachedLatest;
  await writeFile(file, JSON.stringify({ checkedAt: options.now, latest }));
  return latest;
}

/** `a` > `b` on major.minor.patch; anything unreadable is not newer. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
