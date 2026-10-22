#!/usr/bin/env bun
/**
 * Upload location preview images to the R2 public bucket.
 *
 * Reads generated images from preview/locations/,
 * processes to WebP, and uploads to R2 public assets bucket.
 *
 * Usage:
 *   bun scripts/upload-system-previews-to-r2.ts              # Upload all
 *   bun scripts/upload-system-previews-to-r2.ts --dry-run    # Preview only
 */

import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon';

const execFileAsync = promisify(execFile);

const PREVIEW_DIR = path.join(process.cwd(), 'preview');
const THUMBNAIL_SIZE = 256;
const PREVIEW_SIZE = 512;

const isDryRun = process.argv.includes('--dry-run');

const R2_CONFIG = {
  bucket: process.env.R2_PUBLIC_ASSETS_BUCKET || 'openstory-public-assets',
  url: `https://${process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so'}`,
};

async function processImage(
  inputPath: string,
  targetSize: number
): Promise<Buffer> {
  const imageData = await readFile(inputPath);
  const inputBytes = new Uint8Array(imageData);
  const inputImage = PhotonImage.new_from_byteslice(inputBytes);

  try {
    // Maintain aspect ratio: scale so the longest edge fits targetSize
    const srcW = inputImage.get_width();
    const srcH = inputImage.get_height();
    const scale = targetSize / Math.max(srcW, srcH);
    const targetW = Math.round(srcW * scale);
    const targetH = Math.round(srcH * scale);

    const resized = resize(
      inputImage,
      targetW,
      targetH,
      SamplingFilter.Lanczos3
    );

    try {
      const webpBytes = resized.get_bytes_webp();
      return Buffer.from(webpBytes);
    } finally {
      resized.free();
    }
  } finally {
    inputImage.free();
  }
}

async function uploadToR2(
  localPath: string,
  r2Key: string,
  contentType = 'image/webp'
): Promise<void> {
  if (isDryRun) {
    console.log(`  [dry-run] Would upload: ${r2Key}`);
    return;
  }

  try {
    await execFileAsync('bunx', [
      'wrangler',
      'r2',
      'object',
      'put',
      `${R2_CONFIG.bucket}/${r2Key}`,
      `--file=${localPath}`,
      `--content-type=${contentType}`,
      '--remote',
    ]);
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    console.error(`  ❌ Upload failed for ${r2Key}: ${stderr}`);
    throw new Error(`Upload failed: ${r2Key}`);
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function processLocations(): Promise<number> {
  const locationsDir = path.join(PREVIEW_DIR, 'locations');
  if (!(await dirExists(locationsDir))) {
    console.log('  No location previews found under preview/locations.');
    return 0;
  }

  const entries = await readdir(locationsDir, { withFileTypes: true });
  const locationDirs = entries.filter((e) => e.isDirectory());
  let uploaded = 0;

  for (const dir of locationDirs) {
    const locationPath = path.join(locationsDir, dir.name);
    const files = await readdir(locationPath);

    // Only process source files from generate script (preview.webp, sheet.webp)
    const sourceFiles = files.filter(
      (f) => f === 'preview.webp' || f === 'sheet.webp'
    );

    for (const file of sourceFiles) {
      const localPath = path.join(locationPath, file);
      const baseName = file.replace('.webp', '');

      // Upload original
      await uploadToR2(localPath, `locations/${dir.name}/${file}`);
      uploaded++;

      // Upload thumbnail (for preview images)
      if (baseName === 'preview') {
        const thumbBuffer = await processImage(localPath, THUMBNAIL_SIZE);
        const thumbPath = path.join(locationPath, 'thumbnail.webp');
        await writeFile(thumbPath, thumbBuffer);
        await uploadToR2(thumbPath, `locations/${dir.name}/thumbnail.webp`);
        uploaded++;
      }

      // Upload preview size
      const previewBuffer = await processImage(localPath, PREVIEW_SIZE);
      const previewPath = path.join(locationPath, `${baseName}-preview.webp`);
      await writeFile(previewPath, previewBuffer);
      await uploadToR2(
        previewPath,
        `locations/${dir.name}/${baseName}-preview.webp`
      );
      uploaded++;

      console.log(`  ✅ ${dir.name}/${file}`);
    }
  }

  return uploaded;
}

async function main() {
  console.log('📤 Uploading System Previews to R2\n');
  console.log(`   Bucket: ${R2_CONFIG.bucket}`);
  console.log(`   URL: ${R2_CONFIG.url}`);
  if (isDryRun) console.log('   Mode: DRY RUN\n');
  else console.log('');

  console.log('📍 Processing locations...');
  const locationCount = await processLocations();

  console.log(
    `\n🎉 Done: ${locationCount} files ${isDryRun ? 'would be ' : ''}uploaded`
  );

  if (!isDryRun && locationCount > 0) {
    console.log('\nPublic URLs:');
    console.log(
      `  Locations: ${R2_CONFIG.url}/locations/{name}/thumbnail.webp`
    );
  }
}

main().catch(console.error);
