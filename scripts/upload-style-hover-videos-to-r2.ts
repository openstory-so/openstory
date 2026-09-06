#!/usr/bin/env bun
/**
 * Upload style HOVER videos to the R2 public bucket (#801).
 *
 * Scans `sample-videos/{slug}/hover.mp4` produced by
 * generate-style-hover-videos.ts and uploads each to
 * `styles/{slug}/hover.mp4` in the public assets bucket.
 *
 * Deliberately uploads ONLY `hover.mp4` — never `canonical.mp4` / `bespoke.mp4`
 * — so the existing sample videos are never overwritten. (The general
 * `upload-style-sample-videos-to-r2.ts` is the one that touches those.)
 *
 * Default upload path is the wrangler CLI (account-wide CLOUDFLARE_API_TOKEN /
 * `wrangler login`, which has write access to the public bucket), run through a
 * UPLOAD_CONCURRENCY pool.
 *
 * Usage:
 *   bun scripts/upload-style-hover-videos-to-r2.ts            # upload all found
 *   bun scripts/upload-style-hover-videos-to-r2.ts --dry-run  # list keys only
 *   bun scripts/upload-style-hover-videos-to-r2.ts --filter product-ad
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SAMPLE_DIR = path.join(process.cwd(), 'sample-videos');
/** Only ever this file — keeps canonical/bespoke untouched. */
const HOVER_FILE = 'hover.mp4';
const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY ?? '6');

const isDryRun = process.argv.includes('--dry-run');
const filterIdx = process.argv.findIndex((a) => a === '--filter');
const filter = filterIdx >= 0 ? process.argv[filterIdx + 1] : undefined;

const R2_CONFIG = {
  bucket: process.env.R2_PUBLIC_ASSETS_BUCKET || 'openstory-public-assets',
  url: `https://${process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so'}`,
};

type Upload = { localPath: string; r2Key: string };

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function collectUploads(): Promise<Upload[]> {
  if (!(await exists(SAMPLE_DIR))) {
    console.error(
      `Directory not found: ${SAMPLE_DIR}. Run generate-style-hover-videos.ts first.`
    );
    process.exit(1);
  }
  const slugs = (await readdir(SAMPLE_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((slug) => !filter || slug === filter);

  const uploads: Upload[] = [];
  for (const slug of slugs) {
    const localPath = path.join(SAMPLE_DIR, slug, HOVER_FILE);
    if (await exists(localPath)) {
      uploads.push({ localPath, r2Key: `styles/${slug}/${HOVER_FILE}` });
    }
  }
  return uploads;
}

/** Upload one mp4 through the wrangler CLI. */
async function uploadObject(localPath: string, r2Key: string): Promise<void> {
  try {
    await execFileAsync('bunx', [
      'wrangler',
      'r2',
      'object',
      'put',
      `${R2_CONFIG.bucket}/${r2Key}`,
      `--file=${localPath}`,
      '--remote',
    ]);
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(
      `Failed to upload ${r2Key}: ${stderr || (error instanceof Error ? error.message : String(error))}`
    );
  }
}

async function main() {
  const uploads = await collectUploads();
  if (uploads.length === 0) {
    console.log('No hover videos found to upload.');
    return;
  }

  console.log(`Found ${uploads.length} hover video(s) → ${R2_CONFIG.bucket}`);
  if (isDryRun) {
    for (const u of uploads) console.log(`  ${R2_CONFIG.url}/${u.r2Key}`);
    console.log('\nDry run — no uploads. Run without --dry-run to upload.');
    return;
  }

  console.log(`Uploading via wrangler (${UPLOAD_CONCURRENCY} concurrent)…`);

  let success = 0;
  let index = 0;
  const failures: string[] = [];
  const worker = async () => {
    while (index < uploads.length) {
      const u = uploads[index++];
      if (!u) break;
      try {
        await uploadObject(u.localPath, u.r2Key);
        success++;
        console.log(`  ✅ ${u.r2Key}`);
      } catch (error) {
        failures.push(u.r2Key);
        console.error(
          `  ❌ ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, worker)
  );

  console.log(`\nUploaded ${success}/${uploads.length}.`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
