#!/usr/bin/env bun
/**
 * Mirror recorded e2e fixture media onto `openstory-public-assets/e2e/<sha>.<ext>`.
 *
 * Walks `e2e/fixtures/recorded/**`, downloads provider-hosted media, sha256s
 * the bytes, uploads via `wrangler r2 object put … --remote`, and rewrites
 * the fixture JSON in place to the public assets URL.
 *
 * Usage:
 *   bun scripts/mirror-e2e-fixture-media.ts           # download + upload + rewrite
 *   bun scripts/mirror-e2e-fixture-media.ts --dry-run # list URLs, no network writes
 *
 * Requires `wrangler login` (or CLOUDFLARE_API_TOKEN) with write access to
 * `openstory-public-assets`. Scoped R2 keys 403 against that bucket.
 *
 * Dead provider URLs (xAI imgen expires ~24h) are reported and left as-is;
 * a re-record with a live key is the only way to replace them. Exit 1 if
 * any download/upload fails so a record post-step cannot silently rot.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  PUBLIC_ASSETS_BUCKET,
  collectRecordedFixtureMedia,
  publicAssetsDomain,
  shouldMirrorFixtureMediaUrl,
} from './e2e-fixture-media';

const execFileAsync = promisify(execFile);

const isDryRun = process.argv.includes('--dry-run');
const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY ?? '4');
const FETCH_TIMEOUT_MS = 120_000;

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

type MirrorOk = {
  url: string;
  status: 'mirrored' | 'skipped';
  publicUrl: string;
  bytes: number;
  key: string;
};

type MirrorFail = {
  url: string;
  status: 'failed';
  error: string;
};

type MirrorResult = MirrorOk | MirrorFail;

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((item) => fn(item)));
    out.push(...batchResults);
  }
  return out;
}

function extensionOf(url: string, contentType: string | null): string {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
  if (match?.[1]) return match[1].toLowerCase();
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  for (const [ext, mime] of Object.entries(EXT_TO_MIME)) {
    if (mime === type) return ext;
  }
  return 'bin';
}

async function download(url: string): Promise<{
  bytes: Buffer;
  contentType: string | null;
}> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 120).trim();
    const printable = body.startsWith('<') ? '' : body;
    throw new Error(
      `${response.status} ${response.statusText}${printable ? ` ${printable}` : ''}`
    );
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type'),
  };
}

async function uploadObject(
  key: string,
  filePath: string,
  contentType: string
): Promise<void> {
  try {
    await execFileAsync('bunx', [
      'wrangler',
      'r2',
      'object',
      'put',
      `${PUBLIC_ASSETS_BUCKET}/${key}`,
      `--file=${filePath}`,
      `--content-type=${contentType}`,
      '--remote',
      '--force',
    ]);
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(
      stderr || (error instanceof Error ? error.message : String(error))
    );
  }
}

function rewriteFixtures(
  files: readonly string[],
  replacements: ReadonlyMap<string, string>
): number {
  let rewritten = 0;
  for (const file of files) {
    const original = readFileSync(file, 'utf8');
    let next = original;
    for (const [from, to] of replacements) {
      if (next.includes(from)) next = next.replaceAll(from, to);
    }
    if (next === original) continue;
    writeFileSync(file, next);
    rewritten++;
  }
  return rewritten;
}

function uniqueUrls(hits: readonly { url: string }[]): string[] {
  return [...new Set(hits.map((h) => h.url))];
}

async function mirrorUrl(
  url: string,
  tempDir: string,
  uploadedKeys: Map<string, string>
): Promise<MirrorResult> {
  try {
    const { bytes, contentType } = await download(url);
    const ext = extensionOf(url, contentType);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const key = `e2e/${sha}.${ext}`;
    const publicUrl = `https://${publicAssetsDomain()}/${key}`;
    const mime = EXT_TO_MIME[ext] ?? 'application/octet-stream';

    if (!uploadedKeys.has(key)) {
      const filePath = path.join(tempDir, `${sha}.${ext}`);
      await writeFile(filePath, bytes);
      await uploadObject(key, filePath, mime);
      uploadedKeys.set(key, publicUrl);
    }

    return {
      url,
      status: 'mirrored',
      publicUrl,
      bytes: bytes.byteLength,
      key,
    };
  } catch (error) {
    return {
      url,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const hits = collectRecordedFixtureMedia();
  const toMirror = uniqueUrls(
    hits.filter((h) => shouldMirrorFixtureMediaUrl(h.url))
  );
  const alreadyOurs = uniqueUrls(
    hits.filter((h) => !shouldMirrorFixtureMediaUrl(h.url))
  );

  console.log(
    `Found ${hits.length} media URL hit(s) across recorded fixtures.`
  );
  console.log(`  to mirror:          ${toMirror.length}`);
  console.log(`  already on ${publicAssetsDomain()}: ${alreadyOurs.length}`);

  if (toMirror.length === 0) {
    console.log('Nothing to mirror.');
    return;
  }

  if (isDryRun) {
    console.log('\nDry run — no downloads, uploads, or rewrites.\n');
    for (const url of toMirror) {
      const files = hits.filter((h) => h.url === url).map((h) => h.file);
      console.log(`  ${url}`);
      for (const file of files) {
        console.log(`    ${path.relative(process.cwd(), file)}`);
      }
    }
    return;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'e2e-fixture-media-'));
  await mkdir(tempDir, { recursive: true });
  const uploadedKeys = new Map<string, string>();

  try {
    const results = await mapPool(toMirror, UPLOAD_CONCURRENCY, (url) =>
      mirrorUrl(url, tempDir, uploadedKeys)
    );

    const replacements = new Map<string, string>();
    const mirrored: MirrorOk[] = [];
    const failed: MirrorFail[] = [];
    for (const result of results) {
      if (result.status === 'failed') {
        failed.push(result);
        console.error(`  FAIL  ${result.url}\n        ${result.error}`);
        continue;
      }
      mirrored.push(result);
      replacements.set(result.url, result.publicUrl);
      console.log(
        `  OK    ${result.key}  ${formatBytes(result.bytes)}\n        ${result.url}\n     →  ${result.publicUrl}`
      );
    }

    const files = [...new Set(hits.map((h) => h.file))];
    const rewritten = rewriteFixtures(files, replacements);

    const totalBytes = mirrored.reduce((sum, r) => sum + r.bytes, 0);
    console.log('\nSummary');
    console.log(
      `  mirrored:  ${mirrored.length}  (${formatBytes(totalBytes)})`
    );
    console.log(`  skipped:   ${alreadyOurs.length} (already durable)`);
    console.log(`  failed:    ${failed.length}`);
    console.log(`  rewrote:   ${rewritten} fixture file(s)`);
    console.log(`  bucket:    ${PUBLIC_ASSETS_BUCKET}/e2e/`);
    console.log(`  public:    https://${publicAssetsDomain()}/e2e/`);

    if (failed.length > 0) {
      console.error(
        `\n${failed.length} URL(s) could not be mirrored. Dead provider URLs need a re-record with a live key, then re-run this script.`
      );
      process.exit(1);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
