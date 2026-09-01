/**
 * Verify fal.ai cost estimates by running one generation per model variation.
 * Uses fal.subscribe() to wait for completion, then outputs a CSV of
 * estimated costs alongside request IDs and status.
 *
 * Supports two-key mode for per-variation cost isolation:
 *   FAL_KEY_LOW  — used for "low" tier (standard res, shortest duration)
 *   FAL_KEY_HIGH — used for "high" tier (high res, longest duration)
 *
 * Falls back to single FAL_KEY when per-tier keys are not set.
 *
 * Usage (Bun autoloads .env.local; use --env-file= to override):
 *   bun scripts/verify-fal-costs.ts
 *   bun scripts/verify-fal-costs.ts --dry-run
 *   bun scripts/verify-fal-costs.ts --image-url https://example.com/test.jpg
 *   bun scripts/verify-fal-costs.ts --dry-run
 *   bun scripts/verify-fal-costs.ts --retry              # rerun only errored tasks
 *   bun scripts/verify-fal-costs.ts --compare            # fetch usage for existing results
 */

import { estimateFalCost } from '@/lib/ai/fal-cost';
// Verifies the local `model_pricing` snapshot against fal's actual usage.
import { loadLocalFalPricing } from './load-local-fal-pricing';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  type AudioModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import { buildModelInput } from '@/lib/motion/build-model-input';
import { snapDuration } from '@/lib/motion/snap-duration';
import { typedEntries } from '@/lib/utils/typed-object';
import { createFalClient } from '@fal-ai/client';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FAL_PRICING = await loadLocalFalPricing();
// ============================================================================
// Configuration
// ============================================================================

// Two-key mode: FAL_KEY_LOW + FAL_KEY_HIGH for per-variation cost isolation.
// Falls back to single FAL_KEY for backwards compat.
const FAL_KEY_LOW = process.env.FAL_KEY_LOW ?? process.env.FAL_KEY;
const FAL_KEY_HIGH = process.env.FAL_KEY_HIGH ?? process.env.FAL_KEY;

if (!FAL_KEY_LOW || !FAL_KEY_HIGH) {
  console.error(
    'Set FAL_KEY in .env.local (or FAL_KEY_LOW + FAL_KEY_HIGH for two-key mode)'
  );
  process.exit(1);
}

const twoKeyMode = FAL_KEY_LOW !== FAL_KEY_HIGH;
const FAL_PRICING_KEY = process.env.FAL_PRICING_KEY;

const MAX_CONCURRENT = 20;
const TEST_PROMPT =
  'A cinematic mountain landscape at golden hour, detailed, photorealistic, 16:9';
const TEST_VIDEO_PROMPT =
  'Slow camera pan across the landscape with gentle wind';
const TEST_AUDIO_PROMPT =
  'Ambient cinematic orchestral, atmospheric, slow tempo';

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const retryErrors = args.includes('--retry');
const compareOnly = args.includes('--compare');
const imageUrlIdx = args.indexOf('--image-url');
const testImageUrl = imageUrlIdx >= 0 ? args[imageUrlIdx + 1] : undefined;

// Intentionally direct clients that bypass FAL_PROXY_URL (see
// configureFalProxyFromEnv in src/lib/ai/fal-config.ts): this script exists
// to verify real fal costs against real usage data, so routing it through
// the e2e aimock proxy would be pointless.
const falLow = createFalClient({ credentials: FAL_KEY_LOW });
const falHigh = createFalClient({ credentials: FAL_KEY_HIGH });

// ============================================================================
// Types
// ============================================================================

type Tier = 'low' | 'high';

type Task = {
  type: 'image' | 'video' | 'audio';
  modelKey: string;
  endpointId: string;
  variation: string;
  tier: Tier;
  input: Record<string, unknown>;
  /** USD, or null when the model has no honest estimate (#1069). */
  estimatedCostUsd: number | null;
};

type Result = {
  type: string;
  modelKey: string;
  endpointId: string;
  variation: string;
  tier: Tier;
  /** USD, or null when the model has no honest estimate (#1069). */
  estimatedCostUsd: number | null;
  requestId: string;
  status: 'completed' | 'error';
  error: string;
};

/** CSV cell for an unknown estimate — never 0, which reads as "free". */
const UNKNOWN_CELL = 'unknown';

/**
 * Estimator output → the USD this report deals in. `estimateFalCost` returns
 * microdollars; null ("no honest estimate") stays null all the way to the CSV
 * so an unpriced model can never masquerade as a $0.00 one.
 */
function estimateUsd(estimate: Microdollars | null): number | null {
  return estimate == null ? null : microsToUsd(estimate);
}

function formatUsd(value: number | null): string {
  return value == null ? UNKNOWN_CELL : value.toFixed(6);
}

/** Sum of the known estimates, plus how many tasks had none. */
function totalKnownUsd(items: { estimatedCostUsd: number | null }[]): {
  total: number;
  unknown: number;
} {
  let total = 0;
  let unknown = 0;
  for (const item of items) {
    if (item.estimatedCostUsd == null) unknown++;
    else total += item.estimatedCostUsd;
  }
  return { total, unknown };
}

/** CSV cell → estimate. `unknown` (and any unparseable cell) stays null. */
function parseEstimateCell(cell: string | undefined): number | null {
  if (cell == null || cell === UNKNOWN_CELL) return null;
  const parsed = Number.parseFloat(cell);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Report a total that excludes unknowns as the lower bound it actually is. */
function logEstimatedTotal(label: string, total: number, unknown: number) {
  const caveat =
    unknown > 0
      ? ` (LOWER BOUND — ${unknown} task(s) have no estimate and are excluded)`
      : '';
  console.error(`${label} $${total.toFixed(4)}${caveat}`);
}

// ============================================================================
// Image tasks — two 16:9 resolutions: standard (1344×768) and high (1920×1080)
// ============================================================================

type ImageVariation = 'standard' | 'high_res';

const IMAGE_DIMS: Record<ImageVariation, { width: number; height: number }> = {
  standard: { width: 1344, height: 768 },
  high_res: { width: 1920, height: 1080 },
};

function buildImageInput(
  modelKey: TextToImageModel,
  variation: ImageVariation
): Record<string, unknown> {
  const base = { prompt: TEST_PROMPT };
  const isHighRes = variation === 'high_res';

  switch (modelKey) {
    // Nano Banana Pro/2 — aspect_ratio + resolution
    case 'nano_banana_pro':
      return {
        ...base,
        aspect_ratio: '16:9',
        resolution: isHighRes ? '4K' : '2K',
      };

    case 'nano_banana_2':
      return {
        ...base,
        aspect_ratio: '16:9',
        resolution: isHighRes ? '4K' : '1K',
      };

    case 'nano_banana_2_lite':
      // Fixed 1K — no resolution knob.
      return { ...base, aspect_ratio: '16:9' };

    // Grok Imagine — aspect_ratio only
    case 'grok_imagine_image':
    case 'grok_imagine_image_quality':
      return { ...base, aspect_ratio: '16:9' };

    // HiDream — uses image_size
    case 'hidream_i1':
      return {
        ...base,
        image_size: isHighRes
          ? { width: 1920, height: 1080 }
          : { width: 1024, height: 1024 },
      };

    // All other models — image_size (named preset or custom dims)
    default:
      return {
        ...base,
        image_size: isHighRes
          ? { width: 1920, height: 1080 }
          : 'landscape_16_9',
      };
  }
}

function getImageCostResolution(
  modelKey: TextToImageModel,
  variation: ImageVariation
): '0.5K' | '1K' | '2K' | '4K' | undefined {
  const isHighRes = variation === 'high_res';
  switch (modelKey) {
    case 'nano_banana_pro':
      return isHighRes ? '4K' : '2K';
    case 'nano_banana_2':
      return isHighRes ? '4K' : '1K';
    default:
      return undefined;
  }
}

function calculateImageCostForVariation(
  endpointId: string,
  modelKey: TextToImageModel,
  variation: ImageVariation
): number | null {
  const dims = IMAGE_DIMS[variation];
  return estimateUsd(
    estimateFalCost(
      endpointId,
      {
        numImages: 1,
        widthPx: dims.width,
        heightPx: dims.height,
        resolution: getImageCostResolution(modelKey, variation),
      },
      FAL_PRICING
    )
  );
}

function buildImageTasks(): Task[] {
  const tasks: Task[] = [];
  const variations: ImageVariation[] = ['standard', 'high_res'];

  for (const [modelKey, model] of typedEntries(IMAGE_MODELS)) {
    for (const variation of variations) {
      tasks.push({
        type: 'image',
        modelKey,
        endpointId: model.id,
        variation,
        tier: variation === 'standard' ? 'low' : 'high',
        input: buildImageInput(modelKey, variation),
        estimatedCostUsd: calculateImageCostForVariation(
          model.id,
          modelKey,
          variation
        ),
      });
    }
  }

  return tasks;
}

// ============================================================================
// Video tasks — shortest + longest supported duration
// ============================================================================

function buildVideoTasks(imageUrl: string): Task[] {
  const tasks: Task[] = [];
  const seenEndpoints = new Set<string>();

  for (const [modelKey, config] of typedEntries(IMAGE_TO_VIDEO_MODELS)) {
    // Deduplicate shared endpoints (kling_v3_pro / kling_v3_pro_no_audio)
    if (seenEndpoints.has(config.id)) continue;
    seenEndpoints.add(config.id);

    const shortest = snapDuration(1, modelKey);
    const longest = snapDuration(999, modelKey);

    const durationVariations =
      shortest === longest
        ? [{ label: `${shortest}s`, duration: shortest, tier: 'low' as Tier }]
        : [
            { label: `${shortest}s`, duration: shortest, tier: 'low' as Tier },
            { label: `${longest}s`, duration: longest, tier: 'high' as Tier },
          ];

    for (const { label, duration, tier } of durationVariations) {
      const input = buildModelInput(
        {
          prompt: TEST_VIDEO_PROMPT,
          imageUrl,
          duration,
        },
        config,
        modelKey
      );
      const resolution =
        'resolution' in input && typeof input.resolution === 'string'
          ? input.resolution
          : undefined;

      tasks.push({
        type: 'video',
        modelKey,
        endpointId: config.id,
        variation: label,
        tier,
        input: input,
        estimatedCostUsd: estimateUsd(
          estimateFalCost(
            config.id,
            {
              durationSeconds: duration,
              resolution,
            },
            FAL_PRICING
          )
        ),
      });
    }
  }

  return tasks;
}

// ============================================================================
// Audio tasks — short (5s) + long (30s) durations
// ============================================================================

const SKIP_AUDIO_MODELS = new Set<AudioModel>();

function buildAudioInput(
  _modelKey: AudioModel,
  config: (typeof AUDIO_MODELS)[AudioModel],
  durationSeconds: number
): Record<string, unknown> {
  if (config.vendor === 'ElevenLabs') {
    return {
      prompt: TEST_AUDIO_PROMPT,
      music_length_ms: durationSeconds * 1000,
      force_instrumental: true,
    };
  }
  // ACE Studio (v1 + v1.5): prompt + duration in seconds.
  return { prompt: TEST_AUDIO_PROMPT, duration: durationSeconds };
}

function buildAudioTasks(): Task[] {
  const tasks: Task[] = [];

  for (const [modelKey, config] of typedEntries(AUDIO_MODELS)) {
    if (SKIP_AUDIO_MODELS.has(modelKey)) continue;

    const shortDuration = 5;
    const longDuration = Math.min(30, config.capabilities.maxDuration);

    const variations =
      shortDuration === longDuration
        ? [
            {
              label: `${shortDuration}s`,
              duration: shortDuration,
              tier: 'low' as Tier,
            },
          ]
        : [
            {
              label: `${shortDuration}s`,
              duration: shortDuration,
              tier: 'low' as Tier,
            },
            {
              label: `${longDuration}s`,
              duration: longDuration,
              tier: 'high' as Tier,
            },
          ];

    for (const { label, duration, tier } of variations) {
      tasks.push({
        type: 'audio',
        modelKey,
        endpointId: config.id,
        variation: label,
        tier,
        input: buildAudioInput(modelKey, config, duration),
        estimatedCostUsd: estimateUsd(
          estimateFalCost(
            config.id,
            {
              durationSeconds: duration,
            },
            FAL_PRICING
          )
        ),
      });
    }
  }

  return tasks;
}

// ============================================================================
// Semaphore for concurrency limiting
// ============================================================================

class Semaphore {
  private current = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      this.current++;
      next();
    }
  }
}

// ============================================================================
// Task execution
// ============================================================================

async function runTask(task: Task, semaphore: Semaphore): Promise<Result> {
  await semaphore.acquire();

  const client = task.tier === 'high' ? falHigh : falLow;

  try {
    if (dryRun) {
      return {
        type: task.type,
        modelKey: task.modelKey,
        endpointId: task.endpointId,
        variation: task.variation,
        tier: task.tier,
        estimatedCostUsd: task.estimatedCostUsd,
        requestId: 'dry-run',
        status: 'completed',
        error: '',
      };
    }

    const result = await client.subscribe(task.endpointId, {
      input: task.input,
      logs: true,
      pollInterval: 5000,
      timeout: 600_000, // 10 minute timeout per task
    });

    return {
      type: task.type,
      modelKey: task.modelKey,
      endpointId: task.endpointId,
      variation: task.variation,
      tier: task.tier,
      estimatedCostUsd: task.estimatedCostUsd,
      requestId: result.requestId,
      status: 'completed',
      error: '',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      type: task.type,
      modelKey: task.modelKey,
      endpointId: task.endpointId,
      variation: task.variation,
      tier: task.tier,
      estimatedCostUsd: task.estimatedCostUsd,
      requestId: '',
      status: 'error',
      error: message,
    };
  } finally {
    semaphore.release();
  }
}

// ============================================================================
// Usage API (requires FAL_PRICING_KEY)
// ============================================================================

type UsageEntry = {
  endpoint_id: string;
  unit: string;
  quantity: number;
  unit_price: number;
  cost: number;
  currency: string;
  auth_method?: string;
};

type TimeSeriesBucket = {
  bucket: string;
  results: UsageEntry[];
};

type UsageResponse = {
  summary?: UsageEntry[];
  time_series?: TimeSeriesBucket[];
  [key: string]: unknown;
};

async function fetchUsage(
  adminKey: string,
  startTime: string,
  endTime: string,
  endpointIds: string[]
): Promise<UsageResponse> {
  const url = new URL('https://api.fal.ai/v1/models/usage');
  url.searchParams.set('start', startTime);
  url.searchParams.set('end', endTime);
  url.searchParams.append('expand', 'summary');
  url.searchParams.append('expand', 'time_series');
  url.searchParams.append('expand', 'auth_method');
  for (const id of endpointIds) {
    url.searchParams.append('endpoint_id', id);
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Key ${adminKey}` },
  });
  if (!resp.ok) throw new Error(`Usage API: ${resp.status} ${resp.statusText}`);
  const data: UsageResponse = await resp.json();
  return data;
}

// ============================================================================
// CSV output
// ============================================================================

function resultsToCsv(results: Result[]): string {
  const header =
    'type,model_key,endpoint_id,variation,tier,estimated_cost_usd,request_id,status,error';
  const rows = results.map((r) =>
    [
      r.type,
      r.modelKey,
      r.endpointId,
      r.variation,
      r.tier,
      formatUsd(r.estimatedCostUsd),
      r.requestId,
      r.status,
      r.error ? `"${r.error.replace(/"/g, '""')}"` : '',
    ].join(',')
  );
  return [header, ...rows].join('\n') + '\n';
}

function comparisonToCsv(results: Result[], usage: UsageResponse): string {
  // Flatten time_series entries (which carry auth_method), fall back to summary
  const allEntries: UsageEntry[] = [];
  for (const bucket of usage.time_series ?? []) {
    allEntries.push(...bucket.results);
  }
  if (allEntries.length === 0) {
    allEntries.push(...(usage.summary ?? []));
  }

  // Keep only entries whose auth_method contains HIGH or LOW
  const filtered = allEntries.filter((e) => {
    const am = (e.auth_method ?? '').toUpperCase();
    return am.includes('HIGH') || am.includes('LOW');
  });

  // Map auth_method → tier
  const tierFromAuthMethod = (am: string): Tier =>
    am.toUpperCase().includes('HIGH') ? 'high' : 'low';

  // Aggregate actual cost per endpoint+tier
  const actualByKey = new Map<
    string,
    {
      cost: number;
      quantity: number;
      unitPrice: number;
      authMethod: string;
    }
  >();
  for (const entry of filtered) {
    const tier = tierFromAuthMethod(entry.auth_method ?? '');
    const key = `${entry.endpoint_id}|${tier}`;
    const existing = actualByKey.get(key);
    actualByKey.set(key, {
      cost: (existing?.cost ?? 0) + entry.cost,
      quantity: (existing?.quantity ?? 0) + entry.quantity,
      unitPrice: entry.unit_price,
      authMethod: entry.auth_method ?? '',
    });
  }

  // Line-by-line comparison: one row per successful result
  const header =
    'type,model_key,endpoint_id,variation,tier,auth_method,unit_price,quantity,estimated_usd,actual_usd,difference_usd,difference_pct';
  const rows: string[] = [];

  for (const r of results) {
    if (r.status === 'error') continue;
    const key = `${r.endpointId}|${r.tier}`;
    const actual = actualByKey.get(key);
    const actualCost = actual?.cost ?? 0;
    // No estimate → no diff. Reporting `actual - 0` here would read as a
    // 100%-under estimate rather than a missing one (#1069).
    const estimated = r.estimatedCostUsd;
    const diff = estimated == null ? null : actualCost - estimated;
    const diffPct =
      estimated != null && diff != null && estimated > 0
        ? ((diff / estimated) * 100).toFixed(2)
        : estimated == null
          ? UNKNOWN_CELL
          : 'N/A';

    rows.push(
      [
        r.type,
        r.modelKey,
        r.endpointId,
        r.variation,
        r.tier,
        actual?.authMethod ?? '',
        actual?.unitPrice.toFixed(6) ?? '',
        actual?.quantity.toFixed(4) ?? '',
        formatUsd(estimated),
        actualCost.toFixed(6),
        formatUsd(diff),
        diffPct,
      ].join(',')
    );
  }

  return [header, ...rows].join('\n') + '\n';
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.error('=== Fal.ai Cost Verification ===');
  console.error(
    `Mode: ${dryRun ? 'DRY RUN' : 'LIVE (waiting for completion)'}`
  );
  console.error(
    `Key mode: ${twoKeyMode ? 'TWO-KEY (per-variation isolation)' : 'SINGLE-KEY'}`
  );
  console.error(`Max concurrent: ${MAX_CONCURRENT}\n`);

  // --compare: skip generation, load previous results and fetch usage
  if (compareOnly) {
    if (!FAL_PRICING_KEY) {
      console.error(
        'FAL_PRICING_KEY is required for --compare (set in .env.local)'
      );
      process.exit(1);
    }
    const csvPath = path.join(
      process.cwd(),
      'scripts',
      'output',
      'fal-cost-verification.csv'
    );
    const csvContent = await readFile(csvPath, 'utf-8');
    const results: Result[] = [];
    for (const line of csvContent.split('\n').slice(1)) {
      if (!line) continue;
      const cols = line.split(',');
      results.push({
        type: cols[0] ?? '',
        modelKey: cols[1] ?? '',
        endpointId: cols[2] ?? '',
        variation: cols[3] ?? '',
        tier: cols[4] === 'high' ? 'high' : 'low',
        estimatedCostUsd: parseEstimateCell(cols[5]),
        requestId: cols[6] ?? '',
        status: cols[7] === 'completed' ? 'completed' : 'error',
        error: cols.slice(8).join(',').replace(/^"|"$/g, ''),
      });
    }
    console.error(`Loaded ${results.length} results from previous run`);

    // Recalculate estimates from current pricing data
    const freshTasks = [
      ...buildImageTasks(),
      ...buildVideoTasks('https://placeholder'),
      ...buildAudioTasks(),
    ];
    const freshEstimates = new Map<string, number | null>();
    for (const t of freshTasks) {
      freshEstimates.set(`${t.modelKey}|${t.variation}`, t.estimatedCostUsd);
    }
    let recalculated = 0;
    for (const r of results) {
      const key = `${r.modelKey}|${r.variation}`;
      // `has`, not a null check on `get` — a model that has *become* unknown
      // must overwrite its stale number, not keep it.
      if (!freshEstimates.has(key)) continue;
      const fresh = freshEstimates.get(key) ?? null;
      if (fresh !== r.estimatedCostUsd) {
        recalculated++;
        r.estimatedCostUsd = fresh;
      }
    }
    if (recalculated > 0) {
      console.error(
        `Recalculated ${recalculated} estimates from current pricing`
      );
    }

    // Derive time window from the CSV file's mtime (written right after run).
    // Default: 2 hours before mtime → mtime. Override with --start / --end.
    const csvStat = await stat(csvPath);
    const csvMtime = csvStat.mtime.getTime();
    const startIdx = args.indexOf('--start');
    const endIdx = args.indexOf('--end');
    const startTime =
      startIdx >= 0
        ? (args[startIdx + 1] ??
          new Date(csvMtime - 2 * 3600_000).toISOString())
        : new Date(csvMtime - 2 * 3600_000).toISOString();
    const endTime =
      endIdx >= 0
        ? (args[endIdx + 1] ?? new Date(csvMtime).toISOString())
        : new Date(csvMtime).toISOString();
    console.error(`Usage window: ${startTime} → ${endTime}`);

    const successfulResults = results.filter((r) => r.status === 'completed');
    const uniqueEndpoints = [
      ...new Set(successfulResults.map((r) => r.endpointId)),
    ];

    const usage = await fetchUsage(
      FAL_PRICING_KEY,
      startTime,
      endTime,
      uniqueEndpoints
    );

    const outputDir = path.join(process.cwd(), 'scripts', 'output');
    await mkdir(outputDir, { recursive: true });

    const usageRawPath = path.join(outputDir, 'fal-usage-raw.json');
    await writeFile(usageRawPath, JSON.stringify(usage, null, 2) + '\n');
    console.error(`Usage data saved to: ${usageRawPath}`);

    const comparisonCsv = comparisonToCsv(results, usage);
    const comparisonPath = path.join(outputDir, 'fal-cost-comparison.csv');
    await writeFile(comparisonPath, comparisonCsv);
    console.error(`Comparison saved to: ${comparisonPath}`);
    process.stdout.write(comparisonCsv);

    const totalActual = (usage.summary ?? []).reduce(
      (sum, e) => sum + e.cost,
      0
    );
    const { total: totalEstimated, unknown } = totalKnownUsd(successfulResults);
    console.error('\n--- Cost Comparison ---');
    logEstimatedTotal('Total estimated:', totalEstimated, unknown);
    console.error(`Total actual:    $${totalActual.toFixed(4)}`);
    // Actual covers every model; estimated omits the unknowns — the diff is
    // only meaningful once every model has an estimate.
    if (unknown === 0) {
      const totalDiff = totalActual - totalEstimated;
      const totalDiffPct =
        totalEstimated > 0
          ? ((totalDiff / totalEstimated) * 100).toFixed(2)
          : 'N/A';
      console.error(
        `Difference:      $${totalDiff.toFixed(4)} (${totalDiffPct}%)`
      );
    } else {
      console.error(
        'Difference:      not comparable — totals cover different model sets'
      );
    }
    return;
  }

  // Build all tasks
  const imageTasks = buildImageTasks();
  console.error(`Image tasks: ${imageTasks.length} (2 resolutions × 16:9)`);

  let videoTasks: Task[] = [];
  const videoImageUrl = testImageUrl ?? resolveDefaultImageUrl();

  if (videoImageUrl) {
    videoTasks = buildVideoTasks(videoImageUrl);
    console.error(
      `Video tasks: ${videoTasks.length} (shortest + longest duration)`
    );
  } else {
    console.error(
      'Video tasks: SKIPPED (no --image-url or VITE_R2_PUBLIC_ASSETS_DOMAIN)'
    );
  }

  const audioTasks = buildAudioTasks();
  console.error(`Audio tasks: ${audioTasks.length} (5s + 30s)`);

  let allTasks = [...imageTasks, ...videoTasks, ...audioTasks];

  // --retry: filter to only errored tasks from previous run
  if (retryErrors) {
    const csvPath = path.join(
      process.cwd(),
      'scripts',
      'output',
      'fal-cost-verification.csv'
    );
    const csvContent = await readFile(csvPath, 'utf-8');
    const errorKeys = new Set<string>();
    for (const line of csvContent.split('\n').slice(1)) {
      if (!line) continue;
      const cols = line.split(',');
      // cols: type,model_key,endpoint_id,variation,tier,...,status,error
      const status = cols[7];
      if (status === 'error') {
        errorKeys.add(`${cols[1]}|${cols[3]}`); // modelKey|variation
      }
    }
    const before = allTasks.length;
    allTasks = allTasks.filter((t) =>
      errorKeys.has(`${t.modelKey}|${t.variation}`)
    );
    console.error(
      `\nRetry mode: ${allTasks.length} errored tasks (of ${before} total)`
    );
  }

  console.error(`\nTotal tasks: ${allTasks.length}`);

  if (allTasks.length === 0) {
    console.error('No tasks to run.');
    process.exit(0);
  }

  // Print estimated total cost before submitting. This runs real, paid
  // generations, so an unestimated model must be named rather than folded in
  // as $0 — that understatement is the #1069 bug this script exists to catch.
  const { total: totalEstimated, unknown } = totalKnownUsd(allTasks);
  logEstimatedTotal('Estimated total cost:', totalEstimated, unknown);
  if (unknown > 0) {
    const unnamed = [
      ...new Set(
        allTasks
          .filter((t) => t.estimatedCostUsd == null)
          .map((t) => `${t.modelKey} (${t.variation})`)
      ),
    ];
    console.error(`No estimate for: ${unnamed.join(', ')}`);
  }
  console.error('');

  // Record start time for usage API window
  const startTime = new Date().toISOString();

  // Process all tasks with concurrency limit
  const semaphore = new Semaphore(MAX_CONCURRENT);
  let completedCount = 0;

  const results = await Promise.all(
    allTasks.map(async (task) => {
      const result = await runTask(task, semaphore);
      completedCount++;
      const icon = result.status === 'completed' ? '\u2713' : '\u2717';
      console.error(
        `  ${icon} [${completedCount}/${allTasks.length}] ${task.type}/${task.modelKey} (${task.variation})${result.error ? ` — ${result.error.slice(0, 80)}` : ''}`
      );
      return result;
    })
  );

  const endTime = new Date().toISOString();

  const outputDir = path.join(process.cwd(), 'scripts', 'output');
  await mkdir(outputDir, { recursive: true });

  // Save per-task CSV
  const csv = resultsToCsv(results);
  process.stdout.write(csv);
  const csvPath = path.join(outputDir, 'fal-cost-verification.csv');
  await writeFile(csvPath, csv);
  console.error(`\nCSV saved to: ${csvPath}`);

  // Fetch usage data (requires FAL_PRICING_KEY, skip in dry-run)
  if (!dryRun && FAL_PRICING_KEY) {
    const successfulResults = results.filter((r) => r.status === 'completed');
    const uniqueEndpoints = [
      ...new Set(successfulResults.map((r) => r.endpointId)),
    ];

    if (uniqueEndpoints.length > 0) {
      console.error('\nWaiting 10s for usage data to propagate…');
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      console.error('Fetching usage data from fal API…');
      try {
        const usage = await fetchUsage(
          FAL_PRICING_KEY,
          startTime,
          endTime,
          uniqueEndpoints
        );

        // Save raw usage response
        const usageRawPath = path.join(outputDir, 'fal-usage-raw.json');
        await writeFile(usageRawPath, JSON.stringify(usage, null, 2) + '\n');
        console.error(`Usage data saved to: ${usageRawPath}`);

        // Save comparison CSV
        const comparisonCsv = comparisonToCsv(results, usage);
        const comparisonPath = path.join(outputDir, 'fal-cost-comparison.csv');
        await writeFile(comparisonPath, comparisonCsv);
        console.error(`Comparison saved to: ${comparisonPath}`);

        // Print comparison summary
        console.error('\n--- Cost Comparison ---');
        const totalActual = (usage.summary ?? []).reduce(
          (sum, e) => sum + e.cost,
          0
        );
        logEstimatedTotal('Total estimated:', totalEstimated, unknown);
        console.error(`Total actual:    $${totalActual.toFixed(4)}`);
        if (unknown === 0) {
          const totalDiff = totalActual - totalEstimated;
          const totalDiffPct =
            totalEstimated > 0
              ? ((totalDiff / totalEstimated) * 100).toFixed(2)
              : 'N/A';
          console.error(
            `Difference:      $${totalDiff.toFixed(4)} (${totalDiffPct}%)`
          );
        } else {
          console.error(
            'Difference:      not comparable — totals cover different model sets'
          );
        }
      } catch (err) {
        console.error(
          `Failed to fetch usage data: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
      }
    }
  } else if (!dryRun && !FAL_PRICING_KEY) {
    console.error(
      '\nSkipping usage comparison (set FAL_PRICING_KEY in .env.local to enable)'
    );
  }

  // Summary
  const completedResults = results.filter(
    (r) => r.status === 'completed'
  ).length;
  const errors = results.filter((r) => r.status === 'error').length;
  console.error(`\nSummary: ${completedResults} completed, ${errors} errors`);
  logEstimatedTotal('Estimated total cost:', totalEstimated, unknown);
}

function resolveDefaultImageUrl(): string | undefined {
  const r2Domain = process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN;
  if (r2Domain) {
    return `https://${r2Domain}/style-previews/default.webp`;
  }
  return undefined;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
