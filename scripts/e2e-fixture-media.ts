/**
 * Shared helpers for vendoring recorded e2e fixture media onto the durable
 * `openstory-public-assets` bucket (`e2e/<sha>.<ext>`).
 *
 * Replay fetches these bytes for real (R2 is not mocked). Provider CDNs
 * expire — xAI's `imgen.x.ai` in ~24h — so fixtures must not keep those
 * hosts. See #1562.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RECORDED_FIXTURES_DIR = join(
  import.meta.dirname,
  '..',
  'e2e',
  'fixtures',
  'recorded'
);

export const PUBLIC_ASSETS_BUCKET =
  process.env.R2_PUBLIC_ASSETS_BUCKET || 'openstory-public-assets';

const DEFAULT_PUBLIC_ASSETS_DOMAIN = 'assets.openstory.so';

/** Provider CDNs that rot. Subdomains match (`v3b.fal.media`). */
const PROVIDER_MEDIA_HOST_SUFFIXES = ['fal.media', 'imgen.x.ai'] as const;

const MEDIA_PATH_EXT = /\.(png|jpe?g|webp|gif|mp4|webm|mov|mp3|wav|m4a|ogg)$/i;

type FixtureMediaHit = {
  file: string;
  url: string;
};

export function publicAssetsDomain(): string {
  return (
    process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || DEFAULT_PUBLIC_ASSETS_DOMAIN
  );
}

function isOwnAssetsUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  const domain = publicAssetsDomain();
  return host === domain || host.endsWith(`.${domain}`);
}

function isProviderMediaUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return PROVIDER_MEDIA_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  );
}

function isLocalHostUrl(url: string): boolean {
  const host = hostnameOf(url);
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/**
 * A URL replay will fetch as media: provider CDN, or any https URL whose
 * path looks like an image/video/audio file.
 */
function isFixtureMediaUrl(url: string): boolean {
  if (!url.startsWith('https://') && !url.startsWith('http://')) return false;
  if (isLocalHostUrl(url)) return false;
  if (isProviderMediaUrl(url)) return true;
  const pathname = pathnameOf(url);
  return pathname !== null && MEDIA_PATH_EXT.test(pathname);
}

/** Media the mirror script should vendor (not already on our assets domain). */
export function shouldMirrorFixtureMediaUrl(url: string): boolean {
  return isFixtureMediaUrl(url) && !isOwnAssetsUrl(url);
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, out);
  }
  return out;
}

function* walkJsonFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '_unsorted') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonFiles(path);
      continue;
    }
    if (entry.name.endsWith('.json')) yield path;
  }
}

export function collectRecordedFixtureMedia(
  dir: string = RECORDED_FIXTURES_DIR
): FixtureMediaHit[] {
  const hits: FixtureMediaHit[] = [];
  for (const file of walkJsonFiles(dir)) {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const seen = new Set<string>();
    for (const value of collectStrings(parsed)) {
      if (!isFixtureMediaUrl(value) || seen.has(value)) continue;
      seen.add(value);
      hits.push({ file, url: value });
    }
  }
  return hits;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}
