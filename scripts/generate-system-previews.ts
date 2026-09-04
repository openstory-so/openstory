/**
 * Generate Preview Images for System Talent and Locations
 *
 * Generates headshots for system talent and establishing shots for system locations
 * using the same AI image generation pipeline as style previews.
 *
 * Usage:
 *   FAL_KEY=your_key bun scripts/generate-system-previews.ts           # Generate all
 *   FAL_KEY=your_key bun scripts/generate-system-previews.ts talent    # Talent only
 *   FAL_KEY=your_key bun scripts/generate-system-previews.ts locations # Locations only
 *   bun scripts/generate-system-previews.ts                            # Dry-run (no FAL_KEY)
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { DEFAULT_LOCATION_TEMPLATES } from '@/lib/location/location-templates';
import {
  buildLibraryTalentSheetPrompt,
  buildTalentHeadshotPrompt,
} from '@/lib/prompts/character-prompt';
import {
  buildLibraryLocationSheetPrompt,
  buildLocationPreviewPrompt,
} from '@/lib/prompts/location-prompt';
import { DEFAULT_TALENT_TEMPLATES } from '@/lib/talent/talent-templates';
import { PhotonImage } from '@cf-wasm/photon';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const hasFalKey = !!process.env.FAL_KEY;
if (!hasFalKey) {
  console.warn('⚠️  Warning: FAL_KEY environment variable is not set.');
  console.warn(
    '   Running in dry-run mode to preview prompts. No images will be generated.'
  );
  console.warn(
    '   To generate: FAL_KEY=your_key bun scripts/generate-system-previews.ts'
  );
}

const OUTPUT_DIR = path.join(process.cwd(), 'preview');
const MAX_CONCURRENT = 4;

function sanitizeFolderName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function downloadAndConvertToWebP(
  url: string,
  outputPath: string
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to fetch image: ${response.statusText}`);

  const arrayBuffer = await response.arrayBuffer();
  const inputBytes = new Uint8Array(arrayBuffer);
  const image = PhotonImage.new_from_byteslice(inputBytes);

  try {
    const webpBytes = image.get_bytes_webp();
    await writeFile(outputPath, Buffer.from(webpBytes));
  } finally {
    image.free();
  }
}

type Task = {
  name: string;
  type:
    | 'talent-headshot'
    | 'talent-sheet'
    | 'location-preview'
    | 'location-sheet';
  prompt: string;
  imageSize: 'square_hd' | 'landscape_16_9';
  outputPath: string;
};

async function processTask(task: Task): Promise<boolean> {
  const label = `${task.name} (${task.type})`;
  console.log(`  🔄 ${label}`);

  if (!hasFalKey) {
    console.log(`  📝 Prompt preview:\n     ${task.prompt.slice(0, 120)}...\n`);
    return true;
  }

  try {
    const result = await generateImageWithProvider({
      model: DEFAULT_IMAGE_MODEL,
      prompt: task.prompt,
      imageSize: task.imageSize,
      numImages: 1,
      resolution: '1080p',
    });

    const imageUrl = result.imageUrls[0];
    if (!imageUrl) {
      console.error(`  ❌ ${label}: No image URL returned`);
      return false;
    }

    await downloadAndConvertToWebP(imageUrl, task.outputPath);
    console.log(`  ✅ ${label} → ${path.basename(task.outputPath)}`);
    return true;
  } catch (error) {
    console.error(
      `  ❌ ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

async function processWithConcurrency(tasks: Task[]): Promise<number> {
  let completed = 0;
  const queue = [...tasks];

  async function runNext(): Promise<void> {
    const task = queue.shift();
    if (!task) return;
    const success = await processTask(task);
    if (success) completed++;
    await runNext();
  }

  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT, tasks.length) },
    () => runNext()
  );
  await Promise.all(workers);
  return completed;
}

async function main() {
  const filter = process.argv[2]?.toLowerCase();
  const doTalent = !filter || filter === 'talent';
  const doLocations = !filter || filter === 'locations';

  console.log('🎨 Generating System Previews\n');

  await mkdir(OUTPUT_DIR, { recursive: true });

  const tasks: Task[] = [];

  // Talent tasks: headshot + sheet per talent
  if (doTalent) {
    console.log(`👤 Talent: ${DEFAULT_TALENT_TEMPLATES.length} templates`);

    for (const talent of DEFAULT_TALENT_TEMPLATES) {
      const dir = path.join(
        OUTPUT_DIR,
        'talent',
        sanitizeFolderName(talent.name)
      );
      await mkdir(dir, { recursive: true });

      tasks.push({
        name: talent.name,
        type: 'talent-headshot',
        prompt: buildTalentHeadshotPrompt(
          talent.name,
          talent.description ?? undefined,
          false
        ),
        imageSize: 'square_hd',
        outputPath: path.join(dir, 'headshot.webp'),
      });

      tasks.push({
        name: talent.name,
        type: 'talent-sheet',
        prompt: buildLibraryTalentSheetPrompt(
          talent.name,
          talent.description ?? undefined,
          false
        ),
        imageSize: 'landscape_16_9',
        outputPath: path.join(dir, 'sheet.webp'),
      });
    }
  }

  // Location tasks: preview + sheet per location
  if (doLocations) {
    console.log(`📍 Locations: ${DEFAULT_LOCATION_TEMPLATES.length} templates`);

    for (const location of DEFAULT_LOCATION_TEMPLATES) {
      const dir = path.join(
        OUTPUT_DIR,
        'locations',
        sanitizeFolderName(location.name)
      );
      await mkdir(dir, { recursive: true });

      tasks.push({
        name: location.name,
        type: 'location-preview',
        prompt: buildLocationPreviewPrompt(
          location.name,
          location.description ?? undefined,
          false
        ),
        imageSize: 'landscape_16_9',
        outputPath: path.join(dir, 'preview.webp'),
      });

      const sheetResult = buildLibraryLocationSheetPrompt(
        location.name,
        location.description ?? undefined
      );
      tasks.push({
        name: location.name,
        type: 'location-sheet',
        prompt: sheetResult.prompt,
        imageSize: 'landscape_16_9',
        outputPath: path.join(dir, 'sheet.webp'),
      });
    }
  }

  console.log(`\n📋 Total tasks: ${tasks.length}\n`);

  const completed = await processWithConcurrency(tasks);

  console.log(`\n🎉 Done: ${completed}/${tasks.length} generated successfully`);
  if (completed > 0 && hasFalKey) {
    console.log(
      `\n📂 Output: ${OUTPUT_DIR}/talent/ and ${OUTPUT_DIR}/locations/`
    );
    console.log('   Next: bun scripts/upload-system-previews-to-r2.ts');
  }
}

main().catch(console.error);
