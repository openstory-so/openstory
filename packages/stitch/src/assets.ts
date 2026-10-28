/**
 * `stitch pull`: download one sequence's files into a folder.
 *
 * The command asks the public API for the manifest, then writes each file.
 * A second run skips a path whose versionId is unchanged and whose file is
 * still there. Shared cast, location, and style files are stored once under
 * ~/.openstory/assets, named from the stored url, and linked into the folder.
 * This file does not import the app: the skip rule is copied here on purpose.
 */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

export type DownloadAssetsOptions = {
  sequenceId: string;
  origin: string;
  home: string;
  dest: string;
  history: boolean;
  includeExports: boolean;
  fetch?: typeof fetch;
  key: () => Promise<string>;
  refresh: () => Promise<string>;
};

type AssetRow = {
  relativePath: string;
  versionId: string;
  url: string | null;
  text: string | null;
  shared: boolean;
};

export async function downloadSequenceAssets(
  options: DownloadAssetsOptions
): Promise<{ saved: number; skipped: number }> {
  const fetchFn = options.fetch ?? fetch;
  const manifestUrl = new URL(
    `/api/v1/sequences/${encodeURIComponent(options.sequenceId)}/assets`,
    options.origin
  );
  manifestUrl.searchParams.set(
    'scope',
    options.history ? 'history' : 'selected'
  );
  if (options.includeExports) manifestUrl.searchParams.set('exports', 'true');

  let token = await options.key();
  let refreshed = false;
  const authed = async (url: string): Promise<Response> => {
    const run = (bearer: string) =>
      fetchFn(url, { headers: { authorization: `Bearer ${bearer}` } });
    let response = await run(token);
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      token = await options.refresh();
      response = await run(token);
    }
    return response;
  };

  const listed = await authed(manifestUrl.href);
  if (!listed.ok) {
    throw new Error(
      `OpenStory could not list assets (${listed.status}) ${await errorText(listed)}`
    );
  }
  const manifest: unknown = await listed.json();
  const assets = readAssets(manifest);
  for (const asset of assets) {
    if (!safeRelativePath(asset.relativePath)) {
      throw new Error(`Refusing to write ${asset.relativePath}`);
    }
    if (asset.url != null && !asset.url.startsWith('/')) {
      throw new Error(`Refusing ${asset.url}`);
    }
  }

  const previous = await previousVersions(options.dest);
  const present = new Set<string>();
  for (const asset of assets) {
    if (
      previous.get(asset.relativePath) === asset.versionId &&
      (await fileExists(options.dest, asset.relativePath))
    ) {
      present.add(asset.relativePath);
    }
  }
  const todo = assets.filter((asset) => {
    if (asset.url == null && asset.text == null) return false;
    return !present.has(asset.relativePath);
  });

  for (const asset of todo) {
    const dest = join(options.dest, asset.relativePath);
    const cache = asset.shared ? sharedCacheFile(options.home, asset) : null;
    if (asset.text != null) {
      await writeCached(dest, cache, async (file) => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, asset.text ?? '', 'utf8');
      });
    } else if (asset.url != null) {
      const fileUrl = new URL(asset.url, options.origin).href;
      await writeCached(dest, cache, (file) =>
        downloadTo(file, fileUrl, authed)
      );
    }
  }

  await mkdir(options.dest, { recursive: true });
  await writeFile(
    join(options.dest, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  const skipped = assets.length - todo.length;
  return { saved: todo.length, skipped };
}

async function writeCached(
  dest: string,
  cache: string | null,
  write: (file: string) => Promise<void>
): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (!cache) {
    await write(dest);
    return;
  }
  let cached = false;
  try {
    await stat(cache);
    cached = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!cached) await write(cache);
  await linkOver(cache, dest);
}

async function downloadTo(
  file: string,
  url: string,
  authed: (url: string) => Promise<Response>
): Promise<void> {
  const response = await authed(url);
  if (!response.ok || response.body == null) {
    throw new Error(
      `OpenStory could not download ${url} (${response.status}) ${await errorText(response)}`
    );
  }
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.partial`;
  const writable = createWriteStream(partial);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !writable.write(value)) await once(writable, 'drain');
    }
    writable.end();
    await once(writable, 'finish');
  } catch (error) {
    writable.destroy();
    await rm(partial, { force: true });
    throw error;
  }
  await rename(partial, file);
}

async function linkOver(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await rm(to, { force: true });
  try {
    await link(from, to);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : '';
    if (code === 'EXDEV' || code === 'EPERM') {
      await copyFile(from, to);
      return;
    }
    throw error;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function readAssets(manifest: unknown): AssetRow[] {
  if (!manifest || typeof manifest !== 'object' || !('assets' in manifest)) {
    throw new Error('OpenStory answered without an asset list');
  }
  const assets = manifest.assets;
  if (!Array.isArray(assets)) {
    throw new Error('OpenStory answered without an asset list');
  }
  return assets.map((asset, index) => {
    if (!asset || typeof asset !== 'object') {
      throw new Error(`Asset ${index} is not an object`);
    }
    const row = recordOf(asset);
    const relativePath = row.relativePath;
    const versionId = row.versionId;
    if (typeof relativePath !== 'string' || typeof versionId !== 'string') {
      throw new Error(`Asset ${index} has no path`);
    }
    return {
      relativePath,
      versionId,
      url: typeof row.url === 'string' ? row.url : null,
      text: typeof row.text === 'string' ? row.text : null,
      shared: row.shared === true,
    };
  });
}

async function previousVersions(dest: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(join(dest, 'manifest.json'), 'utf8');
  } catch (error) {
    if (isMissing(error)) return new Map();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  const versions = new Map<string, string>();
  if (!parsed || typeof parsed !== 'object' || !('assets' in parsed)) {
    return versions;
  }
  const assets = parsed.assets;
  if (!Array.isArray(assets)) return versions;
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const path = 'relativePath' in asset ? asset.relativePath : null;
    const versionId = 'versionId' in asset ? asset.versionId : null;
    if (typeof path === 'string' && typeof versionId === 'string') {
      versions.set(path, versionId);
    }
  }
  return versions;
}

/** One cache file per stored url. A sheet and its portrait must not collide. */
function sharedCacheFile(home: string, asset: AssetRow): string {
  const ext = extname(asset.relativePath);
  const identity = asset.url
    ? (asset.url.split('?')[0] ?? asset.url)
    : `${asset.versionId}${ext}`;
  const name = createHash('sha256').update(identity).digest('hex');
  return join(home, '.openstory', 'assets', `${name}${ext}`);
}

function safeRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false;
  }
  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}

async function fileExists(
  dest: string,
  relativePath: string
): Promise<boolean> {
  try {
    const info = await stat(join(dest, relativePath));
    return info.isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

async function errorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}
