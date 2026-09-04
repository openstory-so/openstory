import {
  DEFAULT_IMAGE_MODEL,
  safeTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { parseStyleConfig } from '@/lib/style/style-config';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { buildStyledImagePrompt } from '@/lib/style/style-image-prompt';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { PhotonImage } from '@cf-wasm/photon';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Ensure we have the API key
const hasFalKey = !!process.env.FAL_KEY;
if (!hasFalKey) {
  console.warn('⚠️  Warning: FAL_KEY environment variable is not set.');
  console.warn(
    '   Images will NOT be generated. Running in dry-run mode to preview prompts.'
  );
  console.warn(
    '   To generate images, run: FAL_KEY=your_key bun scripts/generate-style-previews.ts'
  );
}

const OUTPUT_DIR = path.join(process.cwd(), 'preview');
const MAX_CONCURRENT = 8;
const MAX_RETRIES = 2; // Retry failed tasks up to 2 times

type Scene = { name: string; prompt: string };

// Preview scenes vary by the kind of style. Narrative/people styles get a
// person/place/action set; object-focused styles (ecommerce, food, automotive,
// product-led commercial) get a product set — forcing "a character portrait" or
// "dynamic action" onto a product-on-white style just produces irrelevant or
// broken previews.
const PEOPLE_SCENES: Scene[] = [
  {
    name: 'character',
    prompt:
      'A close-up portrait of a character looking deeply contemplative, detailed facial features',
  },
  {
    name: 'environment',
    prompt:
      'A wide establishing shot of an atmospheric location, highly detailed environment',
  },
  {
    name: 'action',
    prompt: 'A dynamic scene with movement and energy, cinematic composition',
  },
];

const PRODUCT_SCENES: Scene[] = [
  {
    name: 'hero',
    prompt:
      'A single hero shot of the product as the sole subject, beautifully lit and centered, the product exactly as it ships',
  },
  {
    name: 'detail',
    prompt:
      "An extreme macro close-up of the product's material, texture, and finish",
  },
  {
    name: 'context',
    prompt:
      'The product shown in a real-life context — in use or in its natural setting',
  },
];

const ALL_SCENE_NAMES = [...PEOPLE_SCENES, ...PRODUCT_SCENES].map(
  (s) => s.name
);

const PRODUCT_CATEGORIES = new Set(['ecommerce', 'food', 'automotive']);

/** Object-focused styles get the product scene set; everything else, people. */
function scenesForStyle(
  style: (typeof DEFAULT_STYLE_TEMPLATES)[number]
): Scene[] {
  const isProduct =
    PRODUCT_CATEGORIES.has(style.category ?? '') ||
    (style.category === 'commercial' &&
      (style.useCases ?? [])[0] === 'product');
  return isProduct ? PRODUCT_SCENES : PEOPLE_SCENES;
}

async function downloadAndConvertToWebP(url: string, outputPath: string) {
  try {
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
  } catch (error) {
    throw new Error(
      `Failed to download/convert image from ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Sanitize a style name for use as a folder name.
 * Shares the canonical slug rule with thumbnail/video URLs (see style-slug.ts)
 * so the local `preview/{slug}` folder matches the R2 `/styles/{slug}` path.
 */
function sanitizeFolderName(name: string): string {
  return styleSlug(name);
}

type Task = {
  styleId: string;
  styleName: string;
  sceneName: string;
  prompt: string;
  outputDir: string;
  /** The style's recommended image model (falls back to DEFAULT_IMAGE_MODEL),
   *  so a thumbnail previews the same model the sample video will use. */
  imageModel: TextToImageModel;
};

// Progress tracking for live updates
class ProgressTracker {
  private totalTasks: number;
  private completedTasks: number = 0;
  private failedTasks: number = 0;
  private taskStatuses: Map<
    string,
    'pending' | 'in_progress' | 'completed' | 'failed'
  > = new Map();
  private taskProgress: Map<string, number> = new Map(); // Track progress percentage per task
  private linesToClear: number = 0;
  private lastRenderTime: number = 0;
  private readonly isTTY: boolean;
  private readonly renderThrottleMs: number = 100; // Throttle renders to max once per 100ms

  constructor(totalTasks: number) {
    this.totalTasks = totalTasks;
    this.isTTY = process.stdout.isTTY;
  }

  private clearLines() {
    if (!this.isTTY || this.linesToClear <= 0) {
      return;
    }

    try {
      // Move up and clear lines
      process.stdout.write(`\x1b[${this.linesToClear}A`);
      for (let i = 0; i < this.linesToClear; i++) {
        process.stdout.write('\x1b[K');
      }
    } catch (error) {
      // Silently fail if stdout operations fail (e.g., pipe closed)
      // This prevents crashes when output is redirected
      console.error(
        'Failed to clear lines:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  updateTask(
    taskKey: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
    progress?: number
  ) {
    this.taskStatuses.set(taskKey, status);
    if (progress !== undefined) {
      this.taskProgress.set(taskKey, progress);
    }
    this.render();
  }

  incrementCompleted() {
    this.completedTasks++;
    this.render();
  }

  incrementFailed() {
    this.failedTasks++;
    this.render();
  }

  render() {
    // Throttle renders to prevent too frequent updates
    const now = Date.now();
    if (now - this.lastRenderTime < this.renderThrottleMs && this.isTTY) {
      return;
    }
    this.lastRenderTime = now;

    if (!this.isTTY) {
      // Non-TTY: just log simple updates
      const percentage = Math.round(
        (this.completedTasks / this.totalTasks) * 100
      );
      console.log(
        `Progress: ${percentage}% (${this.completedTasks}/${this.totalTasks} completed, ${this.failedTasks} failed)`
      );
      return;
    }

    try {
      this.clearLines();

      const percentage = Math.round(
        (this.completedTasks / this.totalTasks) * 100
      );
      const progressBarLength = 30;
      const filled = Math.round(
        (this.completedTasks / this.totalTasks) * progressBarLength
      );
      const bar = '█'.repeat(filled) + '░'.repeat(progressBarLength - filled);

      const lines: string[] = [
        `🎨 Progress: [${bar}] ${percentage}% (${this.completedTasks}/${this.totalTasks} completed, ${this.failedTasks} failed)`,
        '',
      ];

      // Show all in-progress tasks first (up to MAX_CONCURRENT), then recently completed/failed
      const allTasks = Array.from(this.taskStatuses.entries());
      const inProgressTasks = allTasks.filter(
        ([_, status]) => status === 'in_progress'
      );
      const otherTasks = allTasks.filter(
        ([_, status]) => status !== 'in_progress'
      );

      // Show all in-progress tasks (should be up to MAX_CONCURRENT), then fill with most recent others
      // Reverse otherTasks to get most recent first, then take what we need
      const recentOthers = otherTasks
        .reverse()
        .slice(0, MAX_CONCURRENT - inProgressTasks.length);
      const sortedTasks = [...inProgressTasks, ...recentOthers].slice(
        0,
        MAX_CONCURRENT
      );

      for (const [taskKey, status] of sortedTasks) {
        const icon =
          status === 'completed'
            ? '✅'
            : status === 'failed'
              ? '❌'
              : status === 'in_progress'
                ? '🔄'
                : '⏳';
        const progress = this.taskProgress.get(taskKey);
        const progressText = progress !== undefined ? ` ${progress}%` : '';
        lines.push(`  ${icon} ${taskKey}${progressText}`);
      }

      // Write all lines at once, ensuring we end with a newline for the last line
      const output = lines.join('\n') + '\n';
      process.stdout.write(output);
      this.linesToClear = lines.length;
    } catch (error) {
      // Silently fail if stdout operations fail (e.g., pipe closed, crash)
      // This prevents crashes when output is redirected or stdout is closed
      if (error instanceof Error && error.message.includes('EPIPE')) {
        // Pipe closed, stop trying to render
        return;
      }
      // For other errors, log but don't crash
      console.error('Progress render error:', error);
    }
  }

  finish() {
    try {
      if (this.isTTY) {
        this.clearLines();
      }
      // Final render without clearing
      const percentage = Math.round(
        (this.completedTasks / this.totalTasks) * 100
      );
      const progressBarLength = 30;
      const filled = Math.round(
        (this.completedTasks / this.totalTasks) * progressBarLength
      );
      const bar = '█'.repeat(filled) + '░'.repeat(progressBarLength - filled);

      console.log(
        `\n🎨 Final Progress: [${bar}] ${percentage}% (${this.completedTasks}/${this.totalTasks} completed, ${this.failedTasks} failed)`
      );
    } catch {
      // Fallback to simple log if rendering fails
      console.log(
        `\n✅ Generation complete: ${this.completedTasks}/${this.totalTasks} completed, ${this.failedTasks} failed`
      );
    }
  }
}

async function processTask(
  task: Task,
  progressTracker: ProgressTracker,
  retryCount: number = 0
): Promise<{ success: boolean; shouldRetry: boolean }> {
  const { styleName, sceneName, prompt, outputDir } = task;
  const taskKey = `${styleName} - ${sceneName}`;
  const retrySuffix =
    retryCount > 0 ? ` (retry ${retryCount}/${MAX_RETRIES})` : '';
  const displayKey = `${taskKey}${retrySuffix}`;

  progressTracker.updateTask(displayKey, 'in_progress');

  if (!hasFalKey) {
    progressTracker.updateTask(displayKey, 'completed');
    progressTracker.incrementCompleted();
    return { success: true, shouldRetry: false };
  }

  try {
    const result = await generateImageWithProvider(
      {
        model: task.imageModel,
        prompt: prompt,
        imageSize: 'square_hd',
        numImages: 1,
        resolution: '1080p',
      },
      {
        onQueueUpdate: (update) => {
          try {
            // Always update task status when we receive an update
            if (
              update.status === 'IN_PROGRESS' ||
              update.status === 'IN_QUEUE'
            ) {
              // Update with progress if available, otherwise just update status
              // Pass undefined if no progress - the tracker will still update the status
              progressTracker.updateTask(
                displayKey,
                'in_progress',
                update.progress // This can be undefined, which is fine
              );
            } else if (update.status === 'COMPLETED') {
              progressTracker.updateTask(displayKey, 'completed');
            } else {
              progressTracker.updateTask(displayKey, 'failed');
            }

            // Debug: log what we're receiving (only when DEBUG env var is set)
            // Use stderr to avoid interfering with progress display
            if (process.env.DEBUG && update.status === 'IN_PROGRESS') {
              process.stderr.write(
                `[DEBUG] ${displayKey}: status=${update.status}, progress=${update.progress ?? 'none'}, logs=${update.logs?.length ?? 0}\n`
              );
            }
          } catch (error) {
            // Silently ignore progress update errors to prevent crashes
            // Progress updates are non-critical
            console.error(
              'Failed to update task:',
              error instanceof Error ? error.message : String(error)
            );
          }
        },
      }
    );

    const imageUrl = result.imageUrls[0];
    if (imageUrl) {
      const filename = `${sceneName}.webp`;
      const filePath = path.join(outputDir, filename);

      await downloadAndConvertToWebP(imageUrl, filePath);
      progressTracker.updateTask(displayKey, 'completed');
      progressTracker.incrementCompleted();
      return { success: true, shouldRetry: false };
    } else {
      // No image URL - retry if we haven't exceeded max retries
      const shouldRetry = retryCount < MAX_RETRIES;
      if (shouldRetry) {
        progressTracker.updateTask(displayKey, 'failed');
        // Don't increment failed count yet - we'll retry
      } else {
        progressTracker.updateTask(displayKey, 'failed');
        progressTracker.incrementFailed();
      }
      return { success: false, shouldRetry };
    }
  } catch (error) {
    console.error(
      'Failed to process task:',
      error instanceof Error ? error.message : String(error)
    );
    // Retry on error if we haven't exceeded max retries
    const shouldRetry = retryCount < MAX_RETRIES;
    if (shouldRetry) {
      progressTracker.updateTask(displayKey, 'failed');
      // Don't increment failed count yet - we'll retry
    } else {
      progressTracker.updateTask(displayKey, 'failed');
      progressTracker.incrementFailed();
    }
    return { success: false, shouldRetry };
  }
}

/**
 * Process tasks with a concurrency limit
 * Maintains MAX_CONCURRENT running jobs, starting new ones as others complete
 * Retries failed tasks up to MAX_RETRIES times
 */
async function processWithConcurrencyLimit(
  tasks: Task[],
  progressTracker: ProgressTracker
): Promise<void> {
  const taskQueue: Array<{ task: Task; retryCount: number }> = tasks.map(
    (task) => ({
      task,
      retryCount: 0,
    })
  );
  let currentIndex = 0;
  const running: Array<{
    promise: Promise<{ success: boolean; shouldRetry: boolean }>;
    task: Task;
    retryCount: number;
  }> = [];

  // Process all tasks (including retries)
  while (currentIndex < taskQueue.length || running.length > 0) {
    // Start new tasks to fill up to MAX_CONCURRENT
    while (running.length < MAX_CONCURRENT && currentIndex < taskQueue.length) {
      const queueItem = taskQueue[currentIndex++];
      if (!queueItem) throw new Error('expected queue item at current index');
      const { task, retryCount } = queueItem;
      const promise = processTask(task, progressTracker, retryCount);
      running.push({ promise, task, retryCount });
    }

    // Wait for at least one task to complete
    if (running.length > 0) {
      // Create a promise that resolves with the index and result
      const racePromises = running.map((r, index) =>
        r.promise
          .then((result) => ({ index, result, status: 'fulfilled' as const }))
          .catch((error) => ({ index, error, status: 'rejected' as const }))
      );

      const completed = await Promise.race(racePromises);
      const completedTask = running[completed.index];
      if (!completedTask)
        throw new Error('expected running task at completed index');

      // Remove completed task from running
      running.splice(completed.index, 1);

      // Handle retry if needed
      if (completed.status === 'fulfilled') {
        const { success, shouldRetry } = completed.result;
        if (!success && shouldRetry) {
          // Add to queue for retry
          taskQueue.push({
            task: completedTask.task,
            retryCount: completedTask.retryCount + 1,
          });
        }
      } else {
        // Promise rejected - retry if we haven't exceeded max retries
        if (completedTask.retryCount < MAX_RETRIES) {
          taskQueue.push({
            task: completedTask.task,
            retryCount: completedTask.retryCount + 1,
          });
        }
      }
    }
  }
}

async function main() {
  console.log('🎨 Starting Style Preview Generation...');
  console.log(`⚡ Max concurrent jobs: ${MAX_CONCURRENT}`);

  // Parse command line arguments. The optional style is the first positional
  // (matched by exact name OR slug); --scene <name> restricts to one scene.
  const args = process.argv.slice(2);
  const styleName = args.find((a) => !a.startsWith('--'))?.trim() ?? null;
  const sceneArg =
    args.find((a) => a.startsWith('--scene='))?.split('=')[1] ??
    (args.includes('--scene') ? args[args.indexOf('--scene') + 1] : undefined);

  if (sceneArg && !ALL_SCENE_NAMES.includes(sceneArg)) {
    console.error(
      `❌ Unknown --scene "${sceneArg}". Options: ${ALL_SCENE_NAMES.join(', ')}`
    );
    process.exit(1);
  }

  if (styleName) {
    console.log(`🎯 Filtering to style: "${styleName}"`);
  }
  if (sceneArg) console.log(`🎬 Only scene: "${sceneArg}"`);

  // 1. Load style templates
  console.log('Loading style templates...');

  // Filter by name or slug if provided
  let systemStyles = DEFAULT_STYLE_TEMPLATES;
  if (styleName) {
    systemStyles = systemStyles.filter(
      (style) => style.name === styleName || styleSlug(style.name) === styleName
    );
  }

  if (styleName && systemStyles.length === 0) {
    console.error(`❌ No style found with name or slug "${styleName}"`);
    console.error('   Available styles:');
    DEFAULT_STYLE_TEMPLATES.forEach((s) => console.error(`   - ${s.name}`));
    process.exit(1);
  }

  console.log(`Found ${systemStyles.length} system style(s).`);

  // Ensure output directory exists
  await mkdir(OUTPUT_DIR, { recursive: true });

  // 2. Prepare all tasks
  const allTasks: Task[] = [];

  for (const style of systemStyles) {
    const sanitizedName = sanitizeFolderName(style.name);
    if (!sanitizedName) {
      console.warn(
        `⚠️  Skipping style "${style.name}" - invalid folder name after sanitization`
      );
      continue;
    }

    const styleDir = path.join(OUTPUT_DIR, sanitizedName);
    try {
      await mkdir(styleDir, { recursive: true });
    } catch (error) {
      console.error(
        `❌ Failed to create directory for style "${style.name}":`,
        error
      );
      continue;
    }

    // Render the thumbnail with the style's recommended image model so it
    // previews the same model the sample video will use (falls back to the
    // default when a template leaves it unset).
    const imageModel = safeTextToImageModel(
      style.recommendedImageModel,
      DEFAULT_IMAGE_MODEL
    );

    // Scene set depends on the style kind (people vs product), optionally
    // narrowed to a single --scene.
    const styleScenes = scenesForStyle(style);
    const scenes = sceneArg
      ? styleScenes.filter((s) => s.name === sceneArg)
      : styleScenes;

    for (const scene of scenes) {
      // Build the prompt: the scene is the subject, the style config is the
      // treatment. We deliberately do NOT inject `style.name` — for
      // medium-named styles it makes the model render the artifact (a book, a
      // storyboard sheet) instead of a scene in that style. See
      // buildStyledImagePrompt.
      const fullPrompt = buildStyledImagePrompt(
        scene.prompt,
        parseStyleConfig(style.config)
      );

      allTasks.push({
        styleId: style.name, // Use name as ID since templates don't have database IDs
        styleName: style.name,
        sceneName: scene.name,
        prompt: fullPrompt,
        outputDir: styleDir,
        imageModel,
      });
    }
  }

  console.log(`Total tasks: ${allTasks.length}\n`);

  // Initialize progress tracker
  const progressTracker = new ProgressTracker(allTasks.length);
  progressTracker.render();

  // 3. Process with concurrency limit
  try {
    await processWithConcurrencyLimit(allTasks, progressTracker);
  } catch (error) {
    console.error(`\n❌ Error during processing:`, error);
  }

  progressTracker.finish();
  console.log('\n✅ Generation complete!');
}

main().catch(console.error);
