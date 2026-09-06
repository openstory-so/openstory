#!/usr/bin/env bun
/**
 * Upload Style Preview Images to R2 Public Bucket
 *
 * Interactive script that:
 * 1. Reads existing images from preview/
 * 2. Processes to 512x512 (preview) and 256x256 (thumbnail) WebP
 * 3. Lets you choose which scene becomes each style's thumbnail
 * 4. Uploads to R2 public assets bucket (shared across all environments)
 *
 * Usage:
 *   bun scripts/upload-style-previews-to-r2.ts              # Upload (interactive)
 *   bun scripts/upload-style-previews-to-r2.ts --dry-run    # Preview only, no uploads
 *   bun scripts/upload-style-previews-to-r2.ts --thumbnail-scene=character --yes
 *                                                           # Non-interactive: one
 *                                                           # scene for all styles,
 *                                                           # no confirm prompt
 *   bun scripts/upload-style-previews-to-r2.ts --thumbnail-map=preview/_thumbnails.json
 *                                                           # Per-style best scene
 *                                                           # (from score-style-previews.ts)
 */

import * as p from '@clack/prompts';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const PREVIEW_DIR = path.join(process.cwd(), 'preview');
const TEMP_DIR = path.join(process.cwd(), '.tmp/r2-upload');
const PREVIEW_SIZE = 512;
const THUMBNAIL_SIZE = 256;
// Parallel uploads. `wrangler r2 object put` spawns a process per file, so
// keep this modest to avoid thrashing.
const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY ?? '6');

const isDryRun = process.argv.includes('--dry-run');
const skipConfirm = process.argv.includes('--yes');
const thumbnailSceneArg = process.argv
  .find((a) => a.startsWith('--thumbnail-scene='))
  ?.split('=')[1];
// Per-style { slug: scene } map (e.g. preview/_thumbnails.json from
// score-style-previews.ts) — auto-picks each style's best-scoring scene.
const thumbnailMapArg = process.argv
  .find((a) => a.startsWith('--thumbnail-map='))
  ?.split('=')[1];

const R2_CONFIG = {
  bucket: process.env.R2_PUBLIC_ASSETS_BUCKET || 'openstory-public-assets',
  url: `https://${process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so'}`,
};

type ImageInfo = {
  styleName: string;
  sanitizedName: string;
  sceneName: string;
  localPath: string;
};

/**
 * Process image to target size as WebP
 */
async function processImage(
  inputPath: string,
  targetSize: number
): Promise<Buffer> {
  const imageData = await readFile(inputPath);
  const inputBytes = new Uint8Array(imageData);
  const inputImage = PhotonImage.new_from_byteslice(inputBytes);

  try {
    const resized = resize(
      inputImage,
      targetSize,
      targetSize,
      SamplingFilter.Lanczos3
    );

    try {
      const outputBytes = resized.get_bytes_webp();
      return Buffer.from(outputBytes);
    } finally {
      resized.free();
    }
  } finally {
    inputImage.free();
  }
}

/**
 * Scan the preview/ directory and collect all images
 */
async function scanStyleImages(): Promise<ImageInfo[]> {
  const images: ImageInfo[] = [];

  try {
    const styleDirectories = await readdir(PREVIEW_DIR, {
      withFileTypes: true,
    });

    for (const dir of styleDirectories) {
      if (!dir.isDirectory()) continue;

      const sanitizedName = dir.name;
      const stylePath = path.join(PREVIEW_DIR, sanitizedName);
      const files = await readdir(stylePath);

      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (!['.webp', '.jpg', '.jpeg'].includes(ext)) continue;

        const sceneName = path.basename(file, ext);
        const localPath = path.join(stylePath, file);

        images.push({
          styleName: sanitizedName
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (l) => l.toUpperCase()),
          sanitizedName,
          sceneName,
          localPath,
        });
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      p.log.error(`Directory not found: ${PREVIEW_DIR}`);
      p.log.info(
        'Run generate-style-previews.ts first to create preview images.'
      );
      process.exit(1);
    }
    throw error;
  }

  return images;
}

/**
 * Upload one object to R2 via the wrangler CLI, which authenticates with your
 * account-wide CLOUDFLARE_API_TOKEN / `wrangler login` and reliably has write
 * access to the public bucket.
 */
async function uploadObject(r2Key: string, buffer: Buffer): Promise<void> {
  const tempFile = path.join(TEMP_DIR, r2Key.replace(/\//g, '-'));
  await mkdir(path.dirname(tempFile), { recursive: true });
  await writeFile(tempFile, buffer);
  try {
    await execFileAsync('bunx', [
      'wrangler',
      'r2',
      'object',
      'put',
      `${R2_CONFIG.bucket}/${r2Key}`,
      `--file=${tempFile}`,
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

/**
 * Upload all images to R2
 */
type UploadJob = { key: string; make: () => Promise<Buffer> };

async function uploadImages(
  images: ImageInfo[],
  thumbnailMap: Map<string, string>
): Promise<{ success: number; failed: number }> {
  // Build the full flat list of files to upload up front: per scene image, the
  // original + a 512px preview, plus a 256px thumbnail for the chosen scene.
  const jobs: UploadJob[] = [];
  for (const img of images) {
    const base = `styles/${img.sanitizedName}`;
    jobs.push({
      key: `${base}/${img.sceneName}.webp`,
      make: () => readFile(img.localPath),
    });
    jobs.push({
      key: `${base}/${img.sceneName}-preview.webp`,
      make: () => processImage(img.localPath, PREVIEW_SIZE),
    });
    const thumbnailScene = thumbnailMap.get(img.sanitizedName) || 'character';
    if (img.sceneName === thumbnailScene) {
      jobs.push({
        key: `${base}/thumbnail.webp`,
        make: () => processImage(img.localPath, THUMBNAIL_SIZE),
      });
    }
  }

  let success = 0;
  let failed = 0;
  let index = 0;
  const spinner = p.spinner();
  spinner.start(
    `Uploading ${jobs.length} files to ${R2_CONFIG.bucket} (${UPLOAD_CONCURRENCY} concurrent)`
  );

  const worker = async () => {
    while (index < jobs.length) {
      const job = jobs[index++];
      if (!job) break;
      try {
        await uploadObject(job.key, await job.make());
        success++;
      } catch (error) {
        failed++;
        p.log.error(
          `Failed: ${job.key} — ${error instanceof Error ? error.message : String(error)}`
        );
      }
      spinner.message(`${success + failed}/${jobs.length} uploaded`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, jobs.length) }, worker)
  );

  spinner.stop(`Uploaded: ${success} files, ${failed} failed`);
  return { success, failed };
}

async function main() {
  p.intro('Style Preview Upload to R2');

  // Scan for images
  const images = await scanStyleImages();
  const styleNames = [...new Set(images.map((i) => i.sanitizedName))];
  const sceneNames = [...new Set(images.map((i) => i.sceneName))];

  if (images.length === 0) {
    p.log.warn('No images found in preview/');
    p.outro('Nothing to upload.');
    return;
  }

  p.log.info(
    `Found ${images.length} images across ${styleNames.length} styles`
  );

  // Non-interactive: per-style best scene from a { slug: scene } map.
  if (thumbnailMapArg) {
    const raw = z
      .record(z.string(), z.string())
      .parse(JSON.parse(await readFile(thumbnailMapArg, 'utf-8')));
    const thumbnailMap = new Map<string, string>(Object.entries(raw));
    const missing = styleNames.filter((s) => !thumbnailMap.has(s));
    if (missing.length > 0) {
      p.log.warn(
        `${missing.length} style(s) absent from the map — defaulting to "character": ${missing.join(', ')}`
      );
      for (const s of missing) thumbnailMap.set(s, 'character');
    }
    p.log.info(`Using per-style thumbnails from ${thumbnailMapArg}.`);
    if (isDryRun) {
      p.log.warn('Dry run — no uploads will be made.');
      p.outro('Dry run complete.');
      return;
    }
    await mkdir(TEMP_DIR, { recursive: true });
    await uploadImages(images, thumbnailMap);
    p.outro('Upload complete!');
    return;
  }

  // Non-interactive: one scene for every style (skips the selection prompt).
  if (thumbnailSceneArg) {
    if (!sceneNames.includes(thumbnailSceneArg)) {
      p.log.error(
        `--thumbnail-scene="${thumbnailSceneArg}" not found. Available: ${sceneNames.join(', ')}`
      );
      process.exit(1);
    }
    const thumbnailMap = new Map<string, string>();
    for (const styleName of styleNames) {
      thumbnailMap.set(styleName, thumbnailSceneArg);
    }
    p.log.info(`Using "${thumbnailSceneArg}" as the thumbnail for all styles.`);
    if (isDryRun) {
      p.log.warn('Dry run — no uploads will be made.');
      p.outro('Dry run complete.');
      return;
    }
    await mkdir(TEMP_DIR, { recursive: true });
    await uploadImages(images, thumbnailMap);
    p.outro('Upload complete!');
    return;
  }

  // 1. Choose thumbnail scene
  const sceneOptions = sceneNames.map((s) => ({
    value: s,
    label: s.charAt(0).toUpperCase() + s.slice(1),
    hint:
      s === 'character'
        ? 'close-up portrait'
        : s === 'environment'
          ? 'wide establishing shot'
          : s === 'action'
            ? 'dynamic scene'
            : undefined,
  }));

  const defaultScene = await p.select({
    message: 'Which scene image for style selector thumbnails?',
    options: [
      ...sceneOptions,
      {
        value: 'per-style' as const,
        label: 'Choose per style',
        hint: 'pick individually',
      },
    ],
  });

  if (p.isCancel(defaultScene)) {
    p.cancel('Upload cancelled.');
    process.exit(0);
  }

  // Build thumbnail map
  const thumbnailMap = new Map<string, string>();

  if (defaultScene === 'per-style') {
    for (const styleName of styleNames) {
      const displayName = styleName
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (l) => l.toUpperCase());

      const styleScenes = images
        .filter((i) => i.sanitizedName === styleName)
        .map((i) => i.sceneName);

      const scene = await p.select({
        message: `Thumbnail for "${displayName}"?`,
        options: styleScenes.map((s) => ({
          value: s,
          label: s.charAt(0).toUpperCase() + s.slice(1),
        })),
      });

      if (p.isCancel(scene)) {
        p.cancel('Upload cancelled.');
        process.exit(0);
      }

      thumbnailMap.set(styleName, scene);
    }
  } else {
    for (const styleName of styleNames) {
      thumbnailMap.set(styleName, defaultScene);
    }
  }

  // 2. Show summary
  const thumbnailSummary =
    defaultScene === 'per-style'
      ? [...thumbnailMap.entries()]
          .map(([style, scene]) => `  ${style}: ${scene}`)
          .join('\n')
      : `  All styles: ${defaultScene}`;

  p.note(
    [
      `Bucket: ${R2_CONFIG.bucket}`,
      `URL: ${R2_CONFIG.url}`,
      `Styles: ${styleNames.length}`,
      `Scene images: ${images.length} (original + ${PREVIEW_SIZE}px)`,
      `Thumbnails: ${styleNames.length} (${THUMBNAIL_SIZE}px)`,
      `Total files: ${images.length * 2 + styleNames.length}`,
      '',
      'Thumbnail scenes:',
      thumbnailSummary,
    ].join('\n'),
    'Upload Summary'
  );

  if (isDryRun) {
    p.log.warn('Dry run — no uploads will be made.');
    p.log.info('Run without --dry-run to upload.');

    const sampleStyle = styleNames[0];
    p.log.info(
      `Sample URL: ${R2_CONFIG.url}/styles/${sampleStyle}/thumbnail.webp`
    );

    p.outro('Dry run complete.');
    return;
  }

  // 3. Confirm
  if (!skipConfirm) {
    const confirmed = await p.confirm({
      message: 'Proceed with upload?',
    });

    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel('Upload cancelled.');
      process.exit(0);
    }
  }

  // 4. Create temp directory and upload
  await mkdir(TEMP_DIR, { recursive: true });
  await uploadImages(images, thumbnailMap);

  p.outro('Upload complete!');
}

main().catch((error) => {
  p.log.error(
    `Error: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
